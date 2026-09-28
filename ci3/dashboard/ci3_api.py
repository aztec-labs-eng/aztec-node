"""The ci3 server API on the dashboard's redis and S3.

The ci3 server handles the following resources:

  logs       Text under an id. Rewritten in place while a job runs; the write marked final is also
             copied to S3, where reads fall back once redis has expired it. Ids can be paths, and a
             prefix can be listed.
  kv         One value per key, optional ttl, batch read.
  lists      Named, newest-first lines, capped on write.
  runs       JSON records indexed by id within a named section, replaced by id, listed newest first.
  artifacts  Files in the build cache bucket, content-addressed by name, read through its public URL.

  GET  /health                          "ci3-server"; no auth.
  PUT  /logs/<id>?ttl=&final=1          store (gzip body ok); final=1 also copies to S3.
  GET  /logs/<id>                       the log, from redis or S3.
  GET  /logs/<prefix>/                  ids under a prefix, one per line (S3).
  PUT  /kv/<key>?ttl=                   set.
  GET  /kv/<key>                        get, 404 if unset.
  POST /kv/mget                         keys as body lines -> one value per line.
  POST /lists/<name>?max=               prepend a line, trim to max.
  GET  /lists/<name>                    the lines.
  PUT  /runs/<section>/<id>             upsert a record.
  GET  /runs/<section>/<id>             the record.
  GET  /runs/<section>                  newest records, JSON array.
  PUT  /artifacts/<name>?ttl=           upload.
  GET  /artifacts/<name>                302 to the public URL.
  HEAD /artifacts/<name>                200 or 404.

Examples of how ci3 uses them:

  logs       Denoised commands, test attempts, a run's top-level log (its CI_LOG_ID), and
             data files under path ids: test-timings/<run>/<test log> and bench/bb-breakdown/<key>.
             A running job re-puts its log every few seconds so it can be watched live; its last
             write is marked with final=1 and written to S3 durably. The dashboard renders them at /<id>.
  kv         The test cache: key = hash of the full test command, value = the log id of its passing
             run, so a test that already passed is skipped. hb-<run id>: the heartbeat a running
             build refreshes every 30s (set-filter.lua marks a run inactive without it).
  lists      history_<test hash>[_<branch>]: one line per attempt of a test. failed_tests[_<section>]:
             every failure and flake. The dashboard renders them at /list/<name>.
  runs       ci-run-<section>: the records the section pages render, written RUNNING when a build
             starts and PASSED/FAILED when it ends; the id is the run's CI_LOG_ID.
  artifacts  <component>-<content hash>.tar.gz build outputs, bench-<tree>.tar.gz, npm-release-<tag>
             .tar.gz, and the ci-success-* marker that lets a whole run be skipped.
"""
import json
import re
import threading
import zlib

from botocore.exceptions import BotoCoreError, ClientError
from flask import Response, abort, redirect, request
from redis.exceptions import RedisError

from rk_core import r

SEGMENT = re.compile(r"[A-Za-z0-9._:+@=,-]+")
RUN_ID = re.compile(r"[0-9]{1,18}")
RESERVED = ("ci-run-", "history_", "failed_tests")  # owned by the runs and lists resources
LOG_TTL = 60 * 60 * 24 * 14
MAX_TTL = 60 * 60 * 24 * 400
LIST_DEFAULT_MAX = 1000
MAX_LIST = 10000
MAX_MGET = 1000
MAX_LISTING = 10000
RUNS_MAX = 1000
MAX_BODY = 64 << 20  # as sent
MAX_EXPANDED = 256 << 20  # after gzip
RUN_FIELDS = ("status", "msg", "name", "author")
CACHE_BUCKET = "aztec-ci-artifacts"
CACHE_PREFIX = "build-cache"
CACHE_PUBLIC_URL = "https://%s.s3.amazonaws.com/%s" % (CACHE_BUCKET, CACHE_PREFIX)
uploads = threading.BoundedSemaphore(4)  # artifact uploads in flight, per worker


def check_key(key):
    if any(p in ("", ".", "..") or not SEGMENT.fullmatch(p) for p in key.split("/")):
        abort(400, "bad path")
    return key


def own_key(key):
    """A key a log or kv write may use: not one of the families runs and lists own."""
    if check_key(key).startswith(RESERVED):
        abort(400, "reserved key")
    return key


def int_arg(name, default, maximum):
    value = request.args.get(name)
    if value is None or value == "":
        return default
    if not value.isdigit() or int(value) < 1 or int(value) > maximum:
        abort(400, "%s must be an integer in 1..%d" % (name, maximum))
    return int(value)


def log_object(prefix, key):
    return "%s/%s.log.gz" % (prefix, key if "/" in key else "%s/%s" % (key[:4], key))


def raw_body():
    length = request.content_length
    if length is None:
        abort(411, "Content-Length required")
    if length > MAX_BODY:
        abort(413, "body larger than %d bytes" % MAX_BODY)
    return request.get_data()


def body():
    data = raw_body()
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


def text(data, missing=""):
    if data is None:
        return Response(missing, status=404, mimetype="text/plain")
    return Response(data, mimetype="text/plain")


def s3_missing(e):
    return e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound")


def register(app, protect, s3, logs_bucket, logs_prefix, password, cache_public_url=CACHE_PUBLIC_URL):
    def route(rule, **kw):
        def deco(fn):
            def guarded(*a, **k):
                if not password:
                    abort(503, "the ci3 API is disabled: DASHBOARD_PASSWORD is not set")
                return fn(*a, **k)
            guarded.__name__ = fn.__name__
            return app.route(rule, **kw)(protect(guarded))
        return deco

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
        return Response("ci3-server", mimetype="text/plain", headers={"X-CI3-Server": "rkapp"})

    # Logs. GET /logs/<prefix>/ lists what is finalised under a prefix (S3 only): a run's test-timings.
    def log_list(prefix):
        names = []
        pages = s3.get_paginator("list_objects_v2").paginate(Bucket=logs_bucket, Prefix="%s/%s/" % (logs_prefix, prefix), Delimiter="/")
        for page in pages:
            for obj in page.get("Contents", []):
                name = obj["Key"].rsplit("/", 1)[-1]
                if name.endswith(".log.gz"):
                    names.append(name[: -len(".log.gz")])
                    if len(names) >= MAX_LISTING:
                        break
            if len(names) >= MAX_LISTING:
                break
        return Response("".join(n + "\n" for n in sorted(names)), mimetype="text/plain")

    @route("/logs/<path:key>", methods=["PUT"])
    def ci3_log_put(key):
        own_key(key)
        ttl = int_arg("ttl", LOG_TTL, MAX_TTL)
        packed = deflate(body())
        final = request.args.get("final") == "1"
        try:
            r.setex(key, ttl, packed)
        except RedisError as e:
            # The final copy is the durable one: it goes to S3 even when redis is down.
            if not final:
                raise
            s3.put_object(Bucket=logs_bucket, Key=log_object(logs_prefix, key), Body=packed)
            raise e
        if final:
            s3.put_object(Bucket=logs_bucket, Key=log_object(logs_prefix, key), Body=packed)
        return "", 204

    @route("/logs/<path:key>", strict_slashes=False)
    def ci3_log_get(key):
        # A trailing slash lists the ids under a prefix; one rule, so werkzeug does not redirect.
        if request.path.endswith("/"):
            return log_list(check_key(key.rstrip("/")))
        check_key(key)
        try:
            data = r.get(key)
        except RedisError as e:
            app.logger.error("ci3 api: redis: %s", e)
            data = None
        if data is None:
            try:
                data = s3.get_object(Bucket=logs_bucket, Key=log_object(logs_prefix, key))["Body"].read()
            except ClientError as e:
                if not s3_missing(e):
                    raise
                data = None
        if data is not None and data[:2] == b"\x1f\x8b":
            data = inflate(data)
        return text(data, "Log not found: %s\n" % key)

    # The test cache and heartbeats. mget is how the test filter checks a batch of 50 commands.
    @route("/kv/mget", methods=["POST"])
    def ci3_kv_mget():
        keys = [k for k in body().decode(errors="replace").split("\n") if k]
        if len(keys) > MAX_MGET:
            abort(413, "at most %d keys" % MAX_MGET)
        values = r.mget([check_key(k) for k in keys]) if keys else []
        # One line per key, whatever the value holds: callers index the answer by position.
        lines = ((v or b"").decode(errors="replace").replace("\n", " ") for v in values)
        return Response("".join(line + "\n" for line in lines), mimetype="text/plain")

    @route("/kv/<path:key>", methods=["PUT"])
    def ci3_kv_put(key):
        own_key(key)
        ttl = int_arg("ttl", None, MAX_TTL)
        data = body()
        if ttl:
            r.setex(key, ttl, data)
        else:
            r.set(key, data)
        return "", 204

    @route("/kv/<path:key>")
    def ci3_kv_get(key):
        return text(r.get(check_key(key)))

    # Test history and failed-test feeds: newest first, bounded.
    @route("/lists/<path:name>", methods=["POST"])
    def ci3_list_push(name):
        check_key(name)
        maximum = int_arg("max", LIST_DEFAULT_MAX, MAX_LIST)
        line = body().decode(errors="replace").rstrip("\n").replace("\n", " ")
        pipe = r.pipeline(transaction=True)
        pipe.lpush(name, line)
        pipe.ltrim(name, 0, maximum - 1)
        pipe.execute()
        return "", 204

    @route("/lists/<path:name>")
    def ci3_list_get(name):
        lines = r.lrange(check_key(name), 0, -1)
        return text(b"".join(l + b"\n" for l in lines) if lines else None)

    # The run registry. A section may contain "/" (merge-train/<x>); the id is the last segment.
    def split_run(rest):
        section, _, run_id = rest.rpartition("/")
        return (section, run_id) if section and RUN_ID.fullmatch(run_id) else (rest, None)

    @route("/runs/<path:rest>", methods=["PUT"])
    def ci3_run_put(rest):
        section, run_id = split_run(rest)
        if run_id is None:
            abort(405)
        key = "ci-run-" + check_key(section)
        try:
            record = json.loads(body())
        except ValueError:
            abort(400, "runs take a JSON object")
        # The dashboard renders these fields and its filter parses compact JSON with the id as timestamp.
        if not isinstance(record, dict) or record.get("timestamp") != int(run_id) or not all(isinstance(record.get(f), str) for f in RUN_FIELDS):
            abort(400, "a run is an object with timestamp == id and string %s" % ", ".join(RUN_FIELDS))
        data = json.dumps(record, separators=(",", ":"))
        pipe = r.pipeline(transaction=True)
        pipe.zremrangebyscore(key, run_id, run_id)
        pipe.zadd(key, {data: int(run_id)})
        pipe.zremrangebyrank(key, 0, -(RUNS_MAX + 1))
        pipe.execute()
        return "", 204

    @route("/runs/<path:rest>")
    def ci3_run_get(rest):
        section, run_id = split_run(rest)
        key = "ci-run-" + check_key(section)
        if run_id is not None:
            found = r.zrangebyscore(key, run_id, run_id)
            return Response(found[0], mimetype="application/json") if found else Response("{}", status=404, mimetype="application/json")
        runs = [json.loads(raw) for raw in r.zrevrange(key, 0, RUNS_MAX - 1)]
        return Response(json.dumps(runs), mimetype="application/json")

    # The build cache. Uploads stream to S3; reads go to the bucket's public endpoint.
    def artifact_key(name):
        return "%s/%s" % (CACHE_PREFIX, check_key(name))

    @route("/artifacts/<path:name>", methods=["PUT"])
    def ci3_artifact_put(name):
        key = artifact_key(name)
        if request.content_length is None:
            abort(411, "Content-Length required")
        if request.headers.get("Content-Encoding"):
            abort(415, "artifacts are uploaded as they are")
        if not uploads.acquire(blocking=False):
            abort(503, "too many uploads in flight; retry")
        try:
            s3.upload_fileobj(request.stream, CACHE_BUCKET, key)
        finally:
            uploads.release()
        return "", 201

    @route("/artifacts/<path:name>", methods=["GET", "HEAD"])
    def ci3_artifact_get(name):
        key = artifact_key(name)
        if request.method == "HEAD":
            try:
                s3.head_object(Bucket=CACHE_BUCKET, Key=key)
                return "", 200
            except ClientError as e:
                if s3_missing(e):
                    return "", 404
                raise
        return redirect("%s/%s" % (cache_public_url.rstrip("/"), check_key(name)), code=302)
