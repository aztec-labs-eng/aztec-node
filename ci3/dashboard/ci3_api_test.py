#!/usr/bin/env python3
"""Tests for ci3_api against a real redis (REDIS_HOST/REDIS_PORT) and an in-memory S3.

  REDIS_HOST=127.0.0.1 REDIS_PORT=6379 python3 ci3_api_test.py
"""
import base64
import gzip
import io
import json
import os
import unittest

os.environ.setdefault("REDIS_HOST", "127.0.0.1")
from botocore.exceptions import ClientError
from flask import Flask
from flask_httpauth import HTTPBasicAuth
from redis.exceptions import RedisError

import ci3_api
from rk_core import r

PASSWORD = "secret"
AUTH = {"Authorization": "Basic " + base64.b64encode(b"aztec:" + PASSWORD.encode()).decode()}


class FakeS3:
    """The five boto3 calls the API makes, on a dict. `failing` makes every call raise."""

    def __init__(self):
        self.objects, self.failing = {}, None

    def _check(self):
        if self.failing:
            raise self.failing

    def put_object(self, Bucket, Key, Body):
        self._check()
        self.objects[(Bucket, Key)] = Body

    def get_object(self, Bucket, Key):
        self._check()
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def head_object(self, Bucket, Key):
        self._check()
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")

    def upload_fileobj(self, stream, Bucket, Key):
        self._check()
        self.objects[(Bucket, Key)] = stream.read()

    def get_paginator(self, name):
        s3 = self

        class Paginator:
            def paginate(self, Bucket, Prefix, Delimiter):
                s3._check()
                keys = [k for (b, k) in s3.objects if b == Bucket and k.startswith(Prefix) and "/" not in k[len(Prefix):]]
                return [{"Contents": [{"Key": k} for k in keys]}]
        return Paginator()


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

    def post(self, path, data=b"", **kw):
        return self.c.post(path, data=data, headers={**AUTH, **kw.pop("headers", {})}, **kw)

    def get(self, path, **kw):
        return self.c.get(path, headers=AUTH, **kw)

    def test_health_is_open_and_everything_else_is_not(self):
        resp = self.c.get("/health")
        self.assertEqual((resp.status_code, resp.data, resp.headers["X-CI3-Server"]), (200, b"ci3-server", "rkapp"))
        self.assertEqual(self.c.put("/kv/k", data=b"v").status_code, 401)
        self.assertEqual(self.c.get("/kv/k").status_code, 401)
        wrong = {"Authorization": "Basic " + base64.b64encode(b"aztec:nope").decode()}
        self.assertEqual(self.c.get("/kv/k", headers=wrong).status_code, 401)

    def test_no_password_disables_the_api(self):
        c = make_app(self.s3, password="").test_client()
        self.assertEqual(c.put("/kv/k", data=b"v").status_code, 503)
        self.assertEqual(c.get("/health").status_code, 200)

    def test_logs_live_and_final(self):
        self.assertEqual(self.put("/logs/abcdef0123456789?ttl=100", b"live\n").status_code, 204)
        self.assertEqual(r.get("abcdef0123456789")[:2], b"\x1f\x8b")
        self.assertTrue(0 < r.ttl("abcdef0123456789") <= 100)
        self.assertEqual(self.s3.objects, {})
        self.assertEqual(self.get("/logs/abcdef0123456789").data, b"live\n")
        self.assertEqual(self.put("/logs/abcdef0123456789?final=1", b"done\n").status_code, 204)
        self.assertEqual(gzip.decompress(self.s3.objects[("logs-bucket", "logs/abcd/abcdef0123456789.log.gz")]), b"done\n")
        r.delete("abcdef0123456789")
        self.assertEqual(self.get("/logs/abcdef0123456789").data, b"done\n")
        self.assertEqual(self.get("/logs/nope").status_code, 404)

    def test_path_ids_and_listing(self):
        self.put("/logs/test-timings/1700000000000123/aaaa?final=1", b"a")
        self.put("/logs/test-timings/1700000000000123/bbbb?final=1", b"b")
        self.assertIn(("logs-bucket", "logs/test-timings/1700000000000123/bbbb.log.gz"), self.s3.objects)
        self.assertEqual(self.get("/logs/test-timings/1700000000000123/").data, b"aaaa\nbbbb\n")
        self.assertEqual(self.put("/logs/bench/bb-breakdown/native-ecdsar1+transfer_0_recursions+sponsored_fpc-abc?final=1", b"{}").status_code, 204)

    def test_gzip_bodies_are_decoded_and_bounded(self):
        self.assertEqual(self.put("/logs/g1", gzip.compress(b"zipped"), headers={"Content-Encoding": "gzip"}).status_code, 204)
        self.assertEqual(self.get("/logs/g1").data, b"zipped")
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

    def test_kv_and_mget(self):
        self.assertEqual(self.put("/kv/0123456789abcdef?ttl=604800", b"logid").status_code, 204)
        self.assertEqual(self.put("/kv/hb-1700000000000123?ttl=60", b"1").status_code, 204)
        self.assertEqual(self.get("/kv/0123456789abcdef").data, b"logid")
        self.assertEqual(self.get("/kv/nope").status_code, 404)
        self.put("/kv/multi", b"two\nlines")
        self.assertEqual(self.post("/kv/mget", b"0123456789abcdef\nnope\nmulti\n").data, b"logid\n\ntwo lines\n")
        self.assertEqual(self.post("/kv/mget", b"\xff\xfe\n").status_code, 400)
        self.assertEqual(self.post("/kv/mget", "\n".join("k%d" % i for i in range(ci3_api.MAX_MGET + 1)).encode()).status_code, 413)

    def test_writes_cannot_cross_into_runs_and_lists(self):
        r.zadd("ci-run-prs", {"{}": 1})
        self.assertEqual(self.put("/kv/ci-run-prs", b"x").status_code, 400)
        self.assertEqual(self.put("/logs/history_abc_next", b"x").status_code, 400)
        self.assertEqual(self.put("/kv/failed_tests_prs", b"x").status_code, 400)
        self.assertEqual(r.type("ci-run-prs"), b"zset")

    def test_bad_arguments_are_400_before_any_mutation(self):
        for bad in ("abc", "-5", "0", str(ci3_api.MAX_TTL + 1)):
            self.assertEqual(self.put("/kv/k?ttl=" + bad, b"v").status_code, 400, bad)
        self.assertIsNone(r.get("k"))
        self.assertEqual(self.post("/lists/h?max=0", b"x").status_code, 400)
        self.assertEqual(self.post("/lists/h?max=abc", b"x").status_code, 400)
        self.assertEqual(r.llen("h"), 0)
        self.assertEqual(self.put("/logs/../etc", b"x").status_code, 400)
        self.assertIn(self.put("/logs/a%0a", b"x").status_code, (400, 404))  # werkzeug rejects it before the view
        self.assertEqual(self.c.put("/kv/k", headers={**AUTH, "Transfer-Encoding": "chunked"}, data=b"v").status_code, 411)

    def test_lists(self):
        for line in ("one", "two", "three"):
            self.assertEqual(self.post("/lists/history_x_next?max=2", line.encode()).status_code, 204)
        self.assertEqual(self.get("/lists/history_x_next").data, b"three\ntwo\n")
        self.assertEqual(self.get("/lists/nolist").status_code, 404)

    def test_runs_are_validated_compact_and_atomic(self):
        record = {"timestamp": 1700000000000111, "status": "RUNNING", "msg": "m", "name": "next", "author": "a", "spot": True}
        self.assertEqual(self.put("/runs/prs/1700000000000111", json.dumps(record, indent=2).encode()).status_code, 204)
        self.assertEqual(r.zrange("ci-run-prs", 0, -1), [json.dumps(record, separators=(",", ":")).encode()])
        record["status"] = "PASSED"
        self.assertEqual(self.put("/runs/prs/1700000000000111", json.dumps(record).encode()).status_code, 204)
        self.assertEqual(r.zcard("ci-run-prs"), 1)
        self.assertEqual(json.loads(self.get("/runs/prs/1700000000000111").data)["status"], "PASSED")
        self.assertEqual(json.loads(self.get("/runs/prs").data)[0]["name"], "next")
        self.assertEqual(self.get("/runs/prs/1").status_code, 404)
        for bad in (b"null", b"[]", b"{}", b"not json", json.dumps({**record, "timestamp": 5}).encode()):
            self.assertEqual(self.put("/runs/prs/1700000000000222", bad).status_code, 400, bad)
        self.assertEqual(self.put("/runs/merge-train/avm/1700000000000333", json.dumps({**record, "timestamp": 1700000000000333}).encode()).status_code, 204)
        self.assertEqual(r.zcard("ci-run-merge-train/avm"), 1)

    def test_artifacts(self):
        self.assertEqual(self.put("/artifacts/foo-abc.tar.gz", b"bytes").status_code, 201)
        self.assertEqual(self.s3.objects[("aztec-ci-artifacts", "build-cache/foo-abc.tar.gz")], b"bytes")
        self.assertEqual(self.c.head("/artifacts/foo-abc.tar.gz", headers=AUTH).status_code, 200)
        self.assertEqual(self.c.head("/artifacts/nope.tar.gz", headers=AUTH).status_code, 404)
        resp = self.get("/artifacts/foo-abc.tar.gz")
        self.assertEqual((resp.status_code, resp.headers["Location"]), (302, "https://aztec-ci-artifacts.s3.amazonaws.com/build-cache/foo-abc.tar.gz"))
        self.assertEqual(self.put("/artifacts/x.tar.gz", b"x", headers={"Content-Encoding": "gzip"}).status_code, 415)

    def test_s3_failures_are_503_not_misses(self):
        self.s3.failing = ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
        self.assertEqual(self.get("/logs/nope").status_code, 503)
        self.assertEqual(self.c.head("/artifacts/nope.tar.gz", headers=AUTH).status_code, 503)
        self.assertEqual(self.put("/logs/x?final=1", b"x").status_code, 503)

    def test_redis_down_still_persists_final_logs_and_reads_s3(self):
        self.put("/logs/durable?final=1", b"kept")
        real, ci3_api.r = ci3_api.r, FailingRedis()
        try:
            self.assertEqual(self.put("/logs/durable2?final=1", b"still").status_code, 503)
            self.assertEqual(gzip.decompress(self.s3.objects[("logs-bucket", "logs/dura/durable2.log.gz")]), b"still")
            self.assertEqual(self.get("/logs/durable").data, b"kept")
            self.assertEqual(self.get("/kv/k").status_code, 503)
        finally:
            ci3_api.r = real


if __name__ == "__main__":
    unittest.main()
