"""The ci3 log API on the dashboard's redis and S3.

  GET /health                    "ci3-server"; no auth.
  PUT /logs/<id>?ttl=&final=1    store a log (gzip body ok), replacing any previous content.

A running job re-puts its log every few seconds so it can be watched live; its last write carries
final=1, which is also copied to S3, where the dashboard's /<id> view falls back once redis has
expired it. Reads go through that view (/<id>.txt for plain text).
"""
import re
import zlib

from botocore.exceptions import BotoCoreError, ClientError
from flask import Response, abort, request
from redis.exceptions import RedisError

from rk_core import r

LOG_ID = re.compile(r"[A-Za-z0-9._:+@=,-]+")
RESERVED = ("ci-run-", "history_", "failed_tests", "hb-")  # the redis families ci3 writes directly
LOG_TTL = 60 * 60 * 24 * 14
MAX_TTL = 60 * 60 * 24 * 400
MAX_BODY = 64 << 20  # as sent
MAX_EXPANDED = 256 << 20  # after gzip


def log_id(key):
    # The /<id>.txt view strips .txt, so such an id could be written but not read back.
    if key in (".", "..") or not LOG_ID.fullmatch(key) or key.startswith(RESERVED) or key.endswith(".txt"):
        abort(400, "bad log id")
    return key


def ttl_arg():
    value = request.args.get("ttl") or str(LOG_TTL)
    if not value.isdigit() or not 1 <= int(value) <= MAX_TTL:
        abort(400, "ttl must be an integer in 1..%d" % MAX_TTL)
    return int(value)


def body():
    if request.content_length is None:
        abort(411, "Content-Length required")
    if request.content_length > MAX_BODY:
        abort(413, "body larger than %d bytes" % MAX_BODY)
    data = request.get_data()
    encoding = request.headers.get("Content-Encoding", "").lower()
    if encoding == "gzip":
        return inflate(data)
    if encoding:
        abort(415, "only gzip content encoding is supported")
    return data


def inflate(data):
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        out = d.decompress(data, MAX_EXPANDED + 1)
    except zlib.error:
        abort(400, "bad gzip body")
    if len(out) > MAX_EXPANDED or d.unconsumed_tail:
        abort(413, "body larger than %d bytes once decompressed" % MAX_EXPANDED)
    if not d.eof:
        abort(400, "truncated gzip body")
    return out


def deflate(data):
    c = zlib.compressobj(wbits=16 + zlib.MAX_WBITS)
    return c.compress(data) + c.flush()


def register(app, protect, s3, logs_bucket, logs_prefix, password):
    @app.errorhandler(RedisError)
    def redis_unavailable(e):
        app.logger.error("ci3 api: redis: %s", e)
        return Response("redis unavailable\n", status=503, mimetype="text/plain")

    @app.errorhandler(BotoCoreError)
    @app.errorhandler(ClientError)
    def s3_unavailable(e):
        app.logger.error("ci3 api: s3: %s", e)
        return Response("s3 unavailable\n", status=503, mimetype="text/plain")

    @app.route("/health")
    def ci3_health():
        return Response("ci3-server", mimetype="text/plain")

    @app.route("/logs/<key>", methods=["PUT"])
    @protect
    def ci3_log_put(key):
        if not password:
            abort(503, "the ci3 API is disabled: DASHBOARD_PASSWORD is not set")
        log_id(key)
        ttl = ttl_arg()
        packed = deflate(body())
        # Redis first, as the view reads it first; either store failing must not stop the other.
        try:
            r.setex(key, ttl, packed)
        finally:
            if request.args.get("final") == "1":
                s3.put_object(Bucket=logs_bucket, Key="%s/%s/%s.log.gz" % (logs_prefix, key[:4], key), Body=packed)
        return "", 204
