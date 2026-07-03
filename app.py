from __future__ import annotations

import json
import hmac
import mimetypes
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
import webbrowser
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
TOOLS_DIR = ROOT / "tools"
DOWNLOAD_DIR = ROOT / "downloads"
HOST = os.environ.get("AUDIO_TOOL_HOST", "127.0.0.1")
PORT = int(os.environ.get("AUDIO_TOOL_PORT") or os.environ.get("PORT", "8765"))
MOCK_MODE = os.environ.get("AUDIO_TOOL_MOCK") == "1"
ACCESS_CODE = os.environ.get("AUDIO_TOOL_ACCESS_CODE", "").strip()
DELETE_AFTER_DOWNLOAD = os.environ.get("AUDIO_TOOL_DELETE_AFTER_DOWNLOAD") == "1"

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/editor.js": "editor.js",
    "/editor-worker.js": "editor-worker.js",
    "/lame.min.js": "lame.min.js",
    "/styles.css": "styles.css",
    "/manifest.webmanifest": "manifest.webmanifest",
    "/service-worker.js": "service-worker.js",
    "/icon.svg": "icon.svg",
}


def is_youtube_url(value: str) -> bool:
    try:
        parsed = urlparse(value.strip())
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    valid_host = host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")
    return valid_host and bool(parsed.path)


def public_job(job: dict) -> dict:
    return {key: value for key, value in job.items() if key != "output_path"}


def update_job(job_id: str, **changes) -> None:
    with JOBS_LOCK:
        JOBS[job_id].update(changes)


def find_tool(name: str) -> Path | None:
    local_names = [f"{name}.exe", name] if os.name == "nt" else [name, f"{name}.exe"]
    for local_name in local_names:
        candidate = TOOLS_DIR / local_name
        if candidate.exists():
            return candidate
    system_path = shutil.which(name)
    return Path(system_path) if system_path else None


def run_mock_job(job_id: str) -> None:
    for progress in (8, 24, 47, 71, 92):
        time.sleep(0.08)
        update_job(job_id, progress=progress, message="音声を変換しています…")
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    mock_path = DOWNLOAD_DIR / "サンプル音声 [mock].mp3"
    mock_path.write_bytes(b"ID3-mock-audio")
    update_job(
        job_id,
        state="complete",
        progress=100,
        message="変換が完了しました",
        filename=mock_path.name,
        output_path=str(mock_path.resolve()),
    )


POT_SERVER_JS = Path(os.environ.get("AUDIO_TOOL_POT_SERVER_JS", "/app/bgutil/server/build/main.js"))
POT_SERVER_PORT = os.environ.get("AUDIO_TOOL_POT_SERVER_PORT", "4416")
COOKIES_FILE = os.environ.get("AUDIO_TOOL_COOKIES_FILE", "").strip()
RUNTIME_COOKIES = ROOT / ".cookies-runtime.txt"


def prepare_cookies() -> None:
    """Render のシークレットファイルは読み取り専用のため、書き込み可能な場所へ複製して使う。"""
    if not COOKIES_FILE:
        return
    source = Path(COOKIES_FILE)
    if not source.exists():
        print(f"Cookies file not found: {COOKIES_FILE}", flush=True)
        return
    shutil.copyfile(source, RUNTIME_COOKIES)
    print(f"Cookies loaded from {COOKIES_FILE}", flush=True)


def cookies_args() -> list[str]:
    return ["--cookies", str(RUNTIME_COOKIES)] if RUNTIME_COOKIES.exists() else []


def run_pot_server() -> None:
    """PO Tokenプロバイダー(bgutil)のNodeサーバーを起動し、落ちたら再起動する。"""
    node = shutil.which("node")
    if not node or not POT_SERVER_JS.exists():
        print(f"PO Token server unavailable (node={node}, script exists={POT_SERVER_JS.exists()})", flush=True)
        return
    while True:
        print(f"Starting PO Token server on port {POT_SERVER_PORT}", flush=True)
        try:
            process = subprocess.Popen(
                [node, str(POT_SERVER_JS), "--port", POT_SERVER_PORT],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            assert process.stdout is not None
            for line in process.stdout:
                print("[bgutil]", line.rstrip(), flush=True)
            print(f"PO Token server exited with code {process.wait()}; restarting in 10s", flush=True)
        except Exception as exc:
            print(f"PO Token server failed to start: {exc}", flush=True)
        time.sleep(10)


BOT_CHECK_MARKER = "Sign in to confirm"
# ボット判定された場合に順番に試すクライアント（PO Token不要とされるもの）
RETRY_CLIENTS = ["android_vr", "web_embedded"]
EXTRA_YTDLP_ARGS = shlex.split(os.environ.get("AUDIO_TOOL_YTDLP_ARGS", ""))


def execute_download(job_id: str, command: list[str]) -> tuple[int, list[str], Path | None]:
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    output_path: Path | None = None
    output_tail: deque[str] = deque(maxlen=40)
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if line:
            output_tail.append(line)
        progress_match = re.search(r"\[download\]\s+([\d.]+)%", line)
        if progress_match:
            progress = min(90, int(float(progress_match.group(1)) * 0.9))
            update_job(job_id, progress=progress, message="動画から音声を取得しています…")
        elif line.startswith("[ExtractAudio]"):
            update_job(job_id, progress=94, message="MP3に変換しています…")
        elif line.startswith("__OUTPUT__:"):
            output_path = Path(line.removeprefix("__OUTPUT__:").strip())
    return process.wait(), list(output_tail), output_path


def run_download(job_id: str, url: str, quality: str) -> None:
    if MOCK_MODE:
        run_mock_job(job_id)
        return

    yt_dlp = find_tool("yt-dlp")
    ffmpeg = find_tool("ffmpeg")
    deno = find_tool("deno")
    if not yt_dlp or not ffmpeg or not deno:
        update_job(
            job_id,
            state="error",
            message="変換エンジンが見つかりません。start.ps1 から起動し直してください。",
        )
        return

    quality_map = {"best": "0", "high": "2", "standard": "5"}
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    output_template = str(DOWNLOAD_DIR / "%(title).180B [%(id)s].%(ext)s")
    base_command = [
        str(yt_dlp),
        "--ignore-config",
        "--no-playlist",
        "--newline",
        "--windows-filenames",
        "--js-runtimes",
        f"deno:{deno}",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        quality_map.get(quality, "2"),
        "--embed-metadata",
        "--ffmpeg-location",
        str(ffmpeg.parent),
        "--output",
        output_template,
        "--print",
        "after_move:__OUTPUT__:%(filepath)s",
        *cookies_args(),
        *EXTRA_YTDLP_ARGS,
    ]
    attempts: list[list[str]] = [[]]
    attempts.extend([["--extractor-args", f"youtube:player_client={client}"] for client in RETRY_CLIENTS])

    try:
        returncode = 1
        output_tail: list[str] = []
        output_path: Path | None = None
        for index, extra_args in enumerate(attempts):
            returncode, output_tail, output_path = execute_download(job_id, [*base_command, *extra_args, url])
            if returncode == 0:
                break
            print(f"yt-dlp attempt {index + 1} failed for {url}:", "\n".join(output_tail), sep="\n", flush=True)
            blocked = any(BOT_CHECK_MARKER in line for line in output_tail)
            if not blocked or index == len(attempts) - 1:
                break
            update_job(job_id, progress=2, message="アクセスが制限されたため、別の方法で再試行しています…")

        if returncode != 0:
            error_line = next((entry for entry in reversed(output_tail) if "ERROR" in entry), "")
            detail = f"詳細: {error_line[:280]}" if error_line else "URLや動画の公開状態を確認してください。"
            raise RuntimeError(f"音声を取得できませんでした。{detail}")

        if output_path is None or not output_path.exists():
            candidates = sorted(DOWNLOAD_DIR.glob("*.mp3"), key=lambda p: p.stat().st_mtime, reverse=True)
            output_path = candidates[0] if candidates else None
        if output_path is None:
            raise RuntimeError("変換後のMP3ファイルを確認できませんでした。")

        update_job(
            job_id,
            state="complete",
            progress=100,
            message="変換が完了しました",
            filename=output_path.name,
            output_path=str(output_path.resolve()),
        )
    except Exception as exc:
        update_job(job_id, state="error", message=str(exc))


class Handler(BaseHTTPRequestHandler):
    server_version = "OfflineAudioPWA/2.0"

    def log_message(self, format: str, *args) -> None:
        return

    def send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_static(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        if path.name == "service-worker.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        self.wfile.write(data)

    def is_authorized(self) -> bool:
        if not ACCESS_CODE:
            return True
        query_code = parse_qs(urlparse(self.path).query).get("code", [""])[0]
        supplied = self.headers.get("X-Access-Code", "") or query_code
        return hmac.compare_digest(supplied, ACCESS_CODE)

    def require_authorization(self) -> bool:
        if self.is_authorized():
            return True
        self.send_json({"error": "アクセスコードが正しくありません"}, HTTPStatus.UNAUTHORIZED)
        return False

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path in STATIC_FILES:
            self.send_static(WEB_DIR / STATIC_FILES[path])
            return
        if path == "/api/config":
            self.send_json({"requiresAccessCode": bool(ACCESS_CODE)})
            return
        if path == "/api/diag":
            if not self.require_authorization():
                return
            diag: dict = {}
            diag["cookies_configured"] = bool(COOKIES_FILE)
            diag["cookies_loaded"] = RUNTIME_COOKIES.exists()
            try:
                with urllib.request.urlopen("http://127.0.0.1:4416/ping", timeout=5) as response:
                    diag["pot_server"] = json.loads(response.read().decode("utf-8"))
            except Exception as exc:
                diag["pot_server"] = f"error: {exc}"
            yt_dlp = find_tool("yt-dlp")
            deno = find_tool("deno")
            if yt_dlp:
                try:
                    command = [str(yt_dlp), "-v", "--ignore-config", "--simulate", "--no-playlist"]
                    if deno:
                        command += ["--js-runtimes", f"deno:{deno}"]
                    command += [
                        "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
                        *cookies_args(),
                        "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
                    ]
                    probe = subprocess.run(command, capture_output=True, text=True, timeout=120, cwd=ROOT)
                    merged = (probe.stderr or "") + "\n" + (probe.stdout or "")
                    interesting = re.compile(r"pot|provider|plugin|token|ERROR|WARNING|Sign in|runtime", re.IGNORECASE)
                    lines = [line for line in merged.splitlines() if interesting.search(line)]
                    diag["ytdlp_returncode"] = probe.returncode
                    diag["ytdlp_probe"] = lines[:40]
                except Exception as exc:
                    diag["ytdlp_probe"] = f"error: {exc}"
            else:
                diag["ytdlp_probe"] = "yt-dlp not found"
            self.send_json(diag)
            return
        if path.startswith("/api/jobs/"):
            if not self.require_authorization():
                return
            job_id = path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                payload = public_job(job) if job else None
            if payload is None:
                self.send_json({"error": "ジョブが見つかりません"}, HTTPStatus.NOT_FOUND)
            else:
                self.send_json(payload)
            return
        if path.startswith("/files/"):
            if not self.require_authorization():
                return
            filename = Path(path.removeprefix("/files/")).name
            file_path = (DOWNLOAD_DIR / filename).resolve()
            if file_path.parent != DOWNLOAD_DIR.resolve() or not file_path.exists():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            file_size = file_path.stat().st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename, safe='')}")
            self.send_header("Content-Length", str(file_size))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                with file_path.open("rb") as source:
                    shutil.copyfileobj(source, self.wfile, length=1024 * 1024)
            finally:
                if DELETE_AFTER_DOWNLOAD:
                    file_path.unlink(missing_ok=True)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/jobs":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self.require_authorization():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 16_384:
                raise ValueError("リクエストが大きすぎます")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            url = str(payload.get("url", "")).strip()
            quality = str(payload.get("quality", "high"))
            rights_confirmed = payload.get("rightsConfirmed") is True
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "入力内容を読み取れませんでした"}, HTTPStatus.BAD_REQUEST)
            return

        if not is_youtube_url(url):
            self.send_json({"error": "有効なYouTube URLを入力してください"}, HTTPStatus.BAD_REQUEST)
            return
        if not rights_confirmed:
            self.send_json({"error": "動画を変換する権利の確認が必要です"}, HTTPStatus.BAD_REQUEST)
            return
        if quality not in {"best", "high", "standard"}:
            self.send_json({"error": "音質の指定が正しくありません"}, HTTPStatus.BAD_REQUEST)
            return

        job_id = uuid.uuid4().hex
        job = {"id": job_id, "state": "working", "progress": 2, "message": "準備しています…"}
        with JOBS_LOCK:
            JOBS[job_id] = job
        threading.Thread(target=run_download, args=(job_id, url, quality), daemon=True).start()
        self.send_json(public_job(job), HTTPStatus.ACCEPTED)


def main() -> None:
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    if not MOCK_MODE:
        prepare_cookies()
        threading.Thread(target=run_pot_server, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    browser_url = f"http://127.0.0.1:{PORT}"
    if ACCESS_CODE:
        browser_url += f"/?code={quote(ACCESS_CODE)}"
    public_url = os.environ.get("RENDER_EXTERNAL_URL")
    print(f"OTO web app: {public_url or f'http://{HOST}:{PORT}'}", flush=True)
    if os.environ.get("AUDIO_TOOL_NO_BROWSER") != "1":
        threading.Timer(0.6, lambda: webbrowser.open(browser_url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
