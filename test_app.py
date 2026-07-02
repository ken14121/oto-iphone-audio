import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

os.environ["AUDIO_TOOL_MOCK"] = "1"
import app


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        test_file = app.DOWNLOAD_DIR / "日本語テスト.mp3"
        if test_file.exists():
            test_file.unlink()
        mock_file = app.DOWNLOAD_DIR / "サンプル音声 [mock].mp3"
        if mock_file.exists():
            mock_file.unlink()

    def request(self, path, data=None, headers=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        body = json.dumps(data).encode() if data is not None else None
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        request = urllib.request.Request(url, data=body, headers=request_headers)
        return urllib.request.urlopen(request)

    def test_home_page(self):
        with self.request("/") as response:
            body = response.read().decode()
        self.assertIn("ライブラリ", body)
        self.assertIn("MP3ダウンロード", body)
        self.assertIn("プレイリスト", body)

    def test_serves_pwa_files(self):
        for path, content_type in (
            ("/manifest.webmanifest", "application/manifest+json"),
            ("/service-worker.js", "javascript"),
            ("/icon.svg", "image/svg+xml"),
        ):
            with self.subTest(path=path), self.request(path) as response:
                self.assertIn(content_type, response.headers["Content-Type"])
                self.assertTrue(response.read())

    def test_rejects_non_youtube_url(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/api/jobs", {"url": "https://example.com/video", "quality": "high", "rightsConfirmed": True})
        self.assertEqual(caught.exception.code, 400)

    def test_mock_conversion_completes(self):
        with self.request("/api/jobs", {"url": "https://youtu.be/example", "quality": "high", "rightsConfirmed": True}) as response:
            job = json.load(response)
        for _ in range(30):
            with self.request(f"/api/jobs/{job['id']}") as response:
                job = json.load(response)
            if job["state"] == "complete":
                break
            time.sleep(0.05)
        self.assertEqual(job["state"], "complete")
        self.assertEqual(job["progress"], 100)

    def test_serves_japanese_filename(self):
        app.DOWNLOAD_DIR.mkdir(exist_ok=True)
        test_file = app.DOWNLOAD_DIR / "日本語テスト.mp3"
        test_file.write_bytes(b"ID3")
        encoded = urllib.parse.quote(test_file.name)
        with self.request(f"/files/{encoded}") as response:
            self.assertEqual(response.read(), b"ID3")
            self.assertIn("%E6%97%A5", response.headers["Content-Disposition"])

    def test_requires_rights_confirmation(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/api/jobs", {"url": "https://youtu.be/example", "quality": "high"})
        self.assertEqual(caught.exception.code, 400)

    def test_access_code_protects_conversion(self):
        original = app.ACCESS_CODE
        app.ACCESS_CODE = "123456"
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.request("/api/jobs", {"url": "https://youtu.be/example", "quality": "high", "rightsConfirmed": True})
            self.assertEqual(caught.exception.code, 401)
            with self.request(
                "/api/jobs",
                {"url": "https://youtu.be/example", "quality": "high", "rightsConfirmed": True},
                {"X-Access-Code": "123456"},
            ) as response:
                self.assertEqual(response.status, 202)
        finally:
            app.ACCESS_CODE = original


if __name__ == "__main__":
    unittest.main()
