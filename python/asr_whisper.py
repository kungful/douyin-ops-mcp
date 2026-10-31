#!/usr/bin/env python3
"""本地 faster-whisper 转写（离线、免费）。

用法：
    python asr_whisper.py <音频或视频文件> [--model small] [--model-dir DIR] [--language zh]

输出：最后一行是一段 JSON：{"text": "...", "segments": [{"start":0.0,"end":2.3,"text":"..."}]}

模型从 ModelScope 下载（huggingface 在国内被污染，ModelScope 的 CT2 转换版可直接用）。
这套仓库映射与 VideoStudio-MCP 一致，模型可以共用同一份缓存目录。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MODELSCOPE = "https://www.modelscope.cn/api/v1/models"

REPOS = {
    "tiny": "pengzhendong/faster-whisper-tiny",
    "base": "pengzhendong/faster-whisper-base",
    "small": "pengzhendong/faster-whisper-small",
    "medium": "pengzhendong/faster-whisper-medium",
    "large-v3": "pengzhendong/faster-whisper-large-v3",
}

FILES = [
    "config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.txt",
    "preprocessor_config.json",
]


def log(msg: str) -> None:
    print(f"[asr] {msg}", file=sys.stderr, flush=True)


def _download(url: str, dest: Path, retries: int = 3) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    last = None
    for _ in range(retries):
        try:
            tmp = dest.with_suffix(dest.suffix + ".part")
            with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1024 * 512)
                    if not chunk:
                        break
                    f.write(chunk)
            tmp.replace(dest)
            return dest
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"下载失败 {dest.name}: {last}")


def ensure_model(size: str, root: Path) -> Path:
    repo = REPOS.get(size)
    if not repo:
        raise SystemExit(f"不认识的模型尺寸 {size}，可选：{list(REPOS)}")
    target = root / f"faster-whisper-{size}"
    if (target / "model.bin").exists():
        return target
    log(f"首次使用，从 ModelScope 下载 {repo} → {target}")
    for name in FILES:
        url = f"{MODELSCOPE}/{repo}/repo?Revision=master&FilePath={urllib.parse.quote(name)}"
        try:
            _download(url, target / name)
            log(f"  ✓ {name}")
        except Exception as exc:  # noqa: BLE001
            # tokenizer.json 之类的可选文件缺失不致命
            if name in ("config.json", "model.bin"):
                raise
            log(f"  ! {name} 跳过（{exc}）")
    return target


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--model", default="small")
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--language", default="zh")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(json.dumps({"error": f"文件不存在: {path}"}, ensure_ascii=False))
        return 2

    root = Path(args.model_dir) if args.model_dir else Path.home() / "douyin-mcp-models"
    model_dir = ensure_model(args.model, root)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "未安装 faster-whisper：pip install faster-whisper"}, ensure_ascii=False))
        return 3

    log(f"加载模型 {model_dir}")
    compute = "int8" if args.device in ("auto", "cpu") else "float16"
    model = WhisperModel(str(model_dir), device=args.device, compute_type=compute)

    log("开始转写…")
    segments, info = model.transcribe(
        str(path),
        language=None if args.language in ("", "auto") else args.language,
        vad_filter=True,
        beam_size=5,
        initial_prompt="以下是普通话视频内容的转写，请加标点。",
    )
    out_segments = []
    texts = []
    for seg in segments:
        out_segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
        texts.append(seg.text.strip())
    text = "".join(texts).strip()
    print(json.dumps({"text": text, "segments": out_segments, "language": info.language}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
