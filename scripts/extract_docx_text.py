from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    root = Path(__file__).resolve().parents[1]
    docx_path = root / "VoiceVault.docx"

    from docx import Document

    doc = Document(str(docx_path))
    for p in doc.paragraphs:
        t = (p.text or "").strip()
        if t:
            print(t)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

