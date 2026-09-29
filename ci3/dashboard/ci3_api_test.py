#!/usr/bin/env python3
"""Tests for ci3_api against a real redis (REDIS_HOST/REDIS_PORT) and an in-memory S3.

  REDIS_HOST=127.0.0.1 REDIS_PORT=6379 python3 ci3_api_test.py
"""
import base64
import gzip
import io
import os
import unittest

os.environ.setdefault("REDIS_HOST", "127.0.0.1")
PASSWORD = "secret"
# What rk reads at import: the dashboard view under test shares this password and bucket.
os.environ["DASHBOARD_PASSWORD"] = PASSWORD
os.environ["S3_LOGS_BUCKET"] = "logs-bucket"
from botocore.exceptions import ClientError
from flask import Flask
from flask_httpauth import HTTPBasicAuth
from redis.exceptions import RedisError

import ci3_api
from rk_core import r

AUTH = {"Authorization": "Basic " + base64.b64encode(b"aztec:" + PASSWORD.encode()).decode()}


class FakeS3:
    """put_object and get_object on a dict. `failing` makes put_object raise."""

    def __init__(self):
        self.objects, self.failing = {}, None

    def put_object(self, Bucket, Key, Body):
        if self.failing:
            raise self.failing
        self.objects[(Bucket, Key)] = Body

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}


class FailingRedis:
    def __getattr__(self, name):
        def fail(*a, **k):
            raise RedisError("down")
        return fail


def make_app(s3, password=PASSWORD):
    app = Flask(__name__)
    app.config["TESTING"] = True
    auth = HTTPBasicAuth()

    @auth.verify_password
    def verify(user, pw):
        return user if user == "aztec" and pw == password else None

    ci3_api.register(app, auth.login_required if password else (lambda f: f), s3, "logs-bucket", "logs", password)
    return app


class ApiTest(unittest.TestCase):
    def setUp(self):
        r.flushdb()
        self.s3 = FakeS3()
        self.c = make_app(self.s3).test_client()

    def put(self, path, data=b"", **kw):
        return self.c.put(path, data=data, headers={**AUTH, **kw.pop("headers", {})}, **kw)

    def test_health_is_open_and_writes_are_not(self):
        resp = self.c.get("/health")
        self.assertEqual((resp.status_code, resp.data), (200, b"ci3-server"))
        self.assertEqual(self.c.put("/logs/k", data=b"v").status_code, 401)
        wrong = {"Authorization": "Basic " + base64.b64encode(b"aztec:nope").decode()}
        self.assertEqual(self.c.put("/logs/k", data=b"v", headers=wrong).status_code, 401)

    def test_no_password_disables_writes(self):
        c = make_app(self.s3, password="").test_client()
        self.assertEqual(c.put("/logs/k", data=b"v").status_code, 503)
        self.assertEqual(c.get("/health").status_code, 200)

    def test_logs_live_and_final(self):
        self.assertEqual(self.put("/logs/abcdef0123456789?ttl=100", b"live\n").status_code, 204)
        self.assertEqual(gzip.decompress(r.get("abcdef0123456789")), b"live\n")
        self.assertTrue(0 < r.ttl("abcdef0123456789") <= 100)
        self.assertEqual(self.s3.objects, {})
        self.assertEqual(self.put("/logs/abcdef0123456789?final=1", b"done\n").status_code, 204)
        self.assertEqual(gzip.decompress(r.get("abcdef0123456789")), b"done\n")
        self.assertEqual(gzip.decompress(self.s3.objects[("logs-bucket", "logs/abcd/abcdef0123456789.log.gz")]), b"done\n")

    def test_gzip_bodies_are_decoded_and_bounded(self):
        self.assertEqual(self.put("/logs/g1", gzip.compress(b"zipped"), headers={"Content-Encoding": "gzip"}).status_code, 204)
        self.assertEqual(gzip.decompress(r.get("g1")), b"zipped")
        self.assertEqual(self.put("/logs/g2", b"not gzip", headers={"Content-Encoding": "gzip"}).status_code, 400)
        self.assertEqual(self.put("/logs/g3", gzip.compress(b"x")[:-5], headers={"Content-Encoding": "gzip"}).status_code, 400)
        self.assertEqual(self.put("/logs/g4", b"x", headers={"Content-Encoding": "br"}).status_code, 415)
        ci3_api.MAX_EXPANDED, saved = 1000, ci3_api.MAX_EXPANDED
        try:
            self.assertEqual(self.put("/logs/bomb", gzip.compress(b"\0" * 5000), headers={"Content-Encoding": "gzip"}).status_code, 413)
            self.assertIsNone(r.get("bomb"))
        finally:
            ci3_api.MAX_EXPANDED = saved
        ci3_api.MAX_BODY, saved = 10, ci3_api.MAX_BODY
        try:
            self.assertEqual(self.put("/logs/big", b"x" * 11).status_code, 413)
        finally:
            ci3_api.MAX_BODY = saved

    def test_bad_requests_are_rejected_before_any_write(self):
        for bad in ("abc", "-5", "0", str(ci3_api.MAX_TTL + 1)):
            self.assertEqual(self.put("/logs/k?ttl=" + bad, b"v").status_code, 400, bad)
        self.assertIsNone(r.get("k"))
        r.zadd("ci-run-prs", {"{}": 1})
        for reserved in ("ci-run-prs", "history_abc_next", "failed_tests_prs", "hb-1700000000000123"):
            self.assertEqual(self.put("/logs/" + reserved, b"x").status_code, 400, reserved)
        self.assertEqual(r.type("ci-run-prs"), b"zset")
        self.assertEqual(self.put("/logs/..", b"x").status_code, 400)
        self.assertEqual(self.put("/logs/report.txt", b"x").status_code, 400)
        self.assertEqual(self.c.put("/logs/k", headers={**AUTH, "Transfer-Encoding": "chunked"}, data=b"v").status_code, 411)

    def test_slow_s3_does_not_hold_back_the_final_log(self):
        in_redis = []
        put_object = self.s3.put_object

        def put_after_redis(Bucket, Key, Body):
            in_redis.append(gzip.decompress(r.get("slow")))
            put_object(Bucket, Key, Body)
        self.s3.put_object = put_after_redis
        self.put("/logs/slow", b"live\n")
        self.put("/logs/slow?final=1", b"done\n")
        self.assertEqual(in_redis, [b"done\n"])

    def test_dashboard_view_reads_live_logs_then_s3(self):
        import rk  # its import starts the dashboard's side services, so only this test pays for it
        real, rk._s3 = rk._s3, self.s3
        try:
            view = rk.app.test_client()
            self.put("/logs/abcdef0123456789", b"live\n")
            self.assertEqual(view.get("/abcdef0123456789.txt", headers=AUTH).data, b"live\n")
            self.put("/logs/abcdef0123456789?final=1", b"done\n")
            r.delete("abcdef0123456789")
            self.assertEqual(view.get("/abcdef0123456789.txt", headers=AUTH).data, b"done\n")
        finally:
            rk._s3 = real

    def test_s3_down_still_updates_redis(self):
        self.s3.failing = ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")
        self.assertEqual(self.put("/logs/x?final=1", b"x").status_code, 503)
        self.assertEqual(gzip.decompress(r.get("x")), b"x")

    def test_redis_down_still_persists_final_logs(self):
        real, ci3_api.r = ci3_api.r, FailingRedis()
        try:
            self.assertEqual(self.put("/logs/durable?final=1", b"still").status_code, 503)
            self.assertEqual(gzip.decompress(self.s3.objects[("logs-bucket", "logs/dura/durable.log.gz")]), b"still")
        finally:
            ci3_api.r = real


if __name__ == "__main__":
    unittest.main()
