import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--model", default="small", help="Whisper model size/name")
    parser.add_argument("--language", default="", help="Optional language code, e.g. en")
    parser.add_argument("--json", action="store_true", help="Output JSON with transcript + detected language")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        sys.stderr.write(
            "Failed to import faster_whisper. Run: .\\scripts\\setup-transcription.ps1 (or pip install -r server/requirements.txt)\n"
        )
        sys.stderr.write(str(e) + "\n")
        return 2

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        use_vad = os.getenv("VOICEVAULT_VAD", "0").strip() == "1"
        segments, info = model.transcribe(
            args.audio,
            language=args.language if args.language else None,
            vad_filter=use_vad,
            vad_parameters={"min_silence_duration_ms": 400} if use_vad else None,
        )

        # Build a readable transcript using segment boundaries.
        # Insert a paragraph break when there's a noticeable pause.
        parts = []
        prev_end = None
        for seg in segments:
            t = (seg.text or "").strip()
            if not t:
                continue
            try:
                start = float(getattr(seg, "start", 0.0) or 0.0)
                end = float(getattr(seg, "end", 0.0) or 0.0)
            except Exception:
                start, end = 0.0, 0.0

            if prev_end is not None and start and (start - prev_end) >= 0.8:
                parts.append("\n\n")
            elif parts:
                parts.append("\n")

            parts.append(t)
            prev_end = end if end else prev_end

        out = "".join(parts).strip()
        detected_language = getattr(info, "language", "") or ""

        if args.json:
            sys.stdout.write(
                json.dumps(
                    {
                        "transcript": out,
                        "language": detected_language,
                    },
                    ensure_ascii=False,
                )
            )
        else:
            sys.stdout.write(out)
        return 0
    except Exception as e:
        sys.stderr.write("Transcription error:\n")
        sys.stderr.write(str(e) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

