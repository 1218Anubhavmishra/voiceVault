import argparse
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--model", default="small", help="Whisper model size/name")
    parser.add_argument("--language", default="", help="Optional language code, e.g. en")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        sys.stderr.write("Failed to import faster_whisper. Run: pip install -r server/requirements.txt\n")
        sys.stderr.write(str(e) + "\n")
        return 2

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            args.audio,
            language=args.language if args.language else None,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
        )

        texts = []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                texts.append(t)

        out = " ".join(texts).strip()
        sys.stdout.write(out)
        return 0
    except Exception as e:
        sys.stderr.write("Transcription error:\n")
        sys.stderr.write(str(e) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

