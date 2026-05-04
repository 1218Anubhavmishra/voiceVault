import argparse
import json
import os
import sys


def _indic_base(lang: str) -> str:
    s = (lang or "").strip().lower()
    if not s:
        return ""
    return s.split("-")[0].split("_")[0]


def _indic_language_explicit(lang: str) -> bool:
    """Whisper ISO codes for languages where Silero VAD often drops real speech."""
    b = _indic_base(lang)
    return b in {
        "hi",
        "ta",
        "te",
        "bn",
        "mr",
        "gu",
        "kn",
        "ml",
        "pa",
        "or",
        "ur",
        "as",
        "sa",
        "ne",
        "sd",
        "doi",
        "kok",
        "sat",
    }


# Short native-script prompts bias Whisper toward Unicode output instead of Romanized transliteration
# when `language` is fixed to that code (common issue: auto-detect → "en" or weak "hi" → Latin script).
INDIC_INITIAL_PROMPTS = {
    "hi": "यह हिंदी में बोला गया है।",
    "ta": "இது தமிழில் பேசப்படுகிறது.",
    "te": "ఇది తెలుగులో మాట్లాడబడుతుంది.",
    "bn": "এটি বাংলায় বলা হয়েছে।",
    "mr": "हे मराठीत बोलले जात आहे.",
    "gu": "આ ગુજરાતીમાં બોલાયું છે.",
    "kn": "ಇದು ಕನ್ನಡದಲ್ಲಿ ಮಾತನಾಡಲಾಗಿದೆ.",
    "ml": "ഇത് മലയാളത്തിൽ സംസാരിക്കുന്നു.",
    "pa": "ਇਹ ਪੰਜਾਬੀ ਵਿੱਚ ਬੋਲਿਆ ਗਿਆ ਹੈ।",
    "or": "ଏହା ଓଡ଼ିଆରେ କୁହାଯାଇଛି।",
    "ur": "یہ اردو میں بولا گیا ہے۔",
    "as": "ইয়াৰ অসমীয়াত কোৱা হৈছে।",
    "sa": "अयं संस्कृते उच्चार्यते।",
    "ne": "यो नेपालीमा बोलिएको छ।",
    "sd": "هي سنڌيءَ ۾ ڳالهيو ويو آهي.",
    "doi": "एह दोगरी च बोलया गेआ ऐ।",
    "kok": "हे कोंकणींत उलयतात।",
    "sat": "ᱱᱚᱣᱟ ᱥᱟᱱᱛᱟᱲᱤ ᱨᱮ ᱨᱚᱲ ᱟᱠᱟᱱᱟ ᱾",
}


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
        device_cfg = os.getenv("VOICEVAULT_WHISPER_DEVICE", "").strip().lower()
        if device_cfg in ("", "auto"):
            device = "cpu"
            try:
                import torch

                if torch.cuda.is_available():
                    device = "cuda"
            except Exception:
                pass
        elif device_cfg in ("cuda", "gpu"):
            device = "cuda"
        else:
            device = device_cfg or "cpu"

        default_ct = "float16" if device == "cuda" else "int8"
        ct = (os.getenv("VOICEVAULT_WHISPER_COMPUTE_TYPE") or "").strip() or default_ct

        try:
            model = WhisperModel(args.model, device=device, compute_type=ct)
        except Exception as e:
            sys.stderr.write(
                f"voiceVault: WhisperModel init failed ({device}/{ct}), falling back to cpu/int8: {e}\n"
            )
            model = WhisperModel(args.model, device="cpu", compute_type="int8")

        # Default VAD ON for English-heavy use; optional env override.
        use_vad = os.getenv("VOICEVAULT_VAD", "1").strip() == "1"
        # Silero VAD frequently removes Indic speech entirely → empty transcript on save.
        # Disable VAD for explicit Indic hints unless VOICEVAULT_VAD_INDICT_STRICT=1 forces it on.
        if _indic_language_explicit(args.language):
            if os.getenv("VOICEVAULT_VAD_INDICT_STRICT", "0").strip() != "1":
                use_vad = False

        def transcribe_once(
            vad_on: bool,
            *,
            force_language: str | None = None,
            initial_prompt: str | None = None,
        ):
            # Defaults match faster-whisper; tune via env for accuracy vs speed.
            try:
                beam = int(os.getenv("VOICEVAULT_WHISPER_BEAM_SIZE", "5").strip() or "5")
            except Exception:
                beam = 5
            if beam < 1:
                beam = 5
            # Reduces runaway repetition / hallucination on noisy or fragmented clips (common with WebM chunks).
            cond_prev = os.getenv("VOICEVAULT_WHISPER_CONDITION_PREV", "0").strip() == "1"
            effective_lang = (force_language or args.language or "").strip() or None
            prom = (initial_prompt or "").strip() or None
            if prom is None and effective_lang and _indic_language_explicit(effective_lang):
                prom = INDIC_INITIAL_PROMPTS.get(_indic_base(effective_lang))

            try:
                lang_det_seg = int(os.getenv("VOICEVAULT_WHISPER_LANG_DETECTION_SEGMENTS", "10").strip() or "10")
            except Exception:
                lang_det_seg = 10
            lang_det_seg = max(1, min(lang_det_seg, 30))

            try:
                lang_det_thr = float(os.getenv("VOICEVAULT_WHISPER_LANG_DETECTION_THRESHOLD", "0.45").strip() or "0.45")
            except Exception:
                lang_det_thr = 0.45
            lang_det_thr = max(0.0, min(lang_det_thr, 1.0))

            hall_raw = os.getenv("VOICEVAULT_WHISPER_HALLUCINATION_SILENCE", "0.9").strip()
            hall_thr = None
            if hall_raw and hall_raw not in ("0", "none", "off"):
                try:
                    hall_thr = float(hall_raw)
                except Exception:
                    hall_thr = 0.9

            kw = dict(
                vad_filter=vad_on,
                vad_parameters={"min_silence_duration_ms": 400} if vad_on else None,
                word_timestamps=True,
                beam_size=beam,
                condition_on_previous_text=cond_prev,
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                no_speech_threshold=0.6,
                initial_prompt=prom,
                language_detection_threshold=lang_det_thr,
                language_detection_segments=lang_det_seg,
            )
            if hall_thr is not None:
                kw["hallucination_silence_threshold"] = hall_thr

            segments_iter, info = model.transcribe(args.audio, language=effective_lang, **kw)

            parts = []
            prev_end = None
            segments_out = []
            for seg in segments_iter:
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

                words_out = []
                try:
                    words = getattr(seg, "words", None) or []
                    for w in words:
                        wtext = (getattr(w, "word", "") or "").strip()
                        if not wtext:
                            continue
                        ws = float(getattr(w, "start", 0.0) or 0.0)
                        we = float(getattr(w, "end", 0.0) or 0.0)
                        if we <= ws:
                            continue
                        words_out.append(
                            {
                                "start": round(max(0.0, ws), 3),
                                "end": round(max(0.0, we), 3),
                                "word": wtext,
                            }
                        )
                except Exception:
                    words_out = []

                segments_out.append(
                    {
                        "start": round(max(0.0, start), 3),
                        "end": round(max(0.0, end), 3),
                        "text": t,
                        "words": words_out,
                    }
                )

            out = "".join(parts).strip()
            detected_language = str(getattr(info, "language", "") or "").strip()
            return out, detected_language, segments_out

        out, detected_language, segments_out = transcribe_once(use_vad)

        # If VAD removed everything (common for Hindi auto-detect + noisy audio), retry once without VAD.
        if not out and use_vad:
            sys.stderr.write("voiceVault: empty transcript with VAD; retrying without VAD\n")
            out, detected_language, segments_out = transcribe_once(False)

        # Auto-detect often picks English on Hindi-only clips, or emits Romanized Hindi. If the detector
        # still lands on an Indic code, a second pass with explicit `language` + native-script prompt
        # strongly biases Devanagari / native script (set VOICEVAULT_WHISPER_INDIC_REFINE=0 to skip).
        refine = os.getenv("VOICEVAULT_WHISPER_INDIC_REFINE", "1").strip() == "1"
        hint_empty = not (args.language or "").strip()
        if refine and hint_empty and (out or "").strip():
            det_b = _indic_base(detected_language)
            if det_b in INDIC_INITIAL_PROMPTS:
                ip = INDIC_INITIAL_PROMPTS[det_b]
                out2, det2, seg2 = transcribe_once(use_vad, force_language=det_b, initial_prompt=ip)
                if (out2 or "").strip():
                    out, detected_language, segments_out = out2, det2, seg2

        # Hindi-only audio is often mis-detected as English → Romanized output. Opt-in re-decode as Hindi.
        try_hi = os.getenv("VOICEVAULT_WHISPER_TRY_HI_WHEN_EN", "0").strip() == "1"
        if refine and try_hi and hint_empty and (out or "").strip():
            if _indic_base(detected_language) == "en":
                ip = INDIC_INITIAL_PROMPTS.get("hi")
                out2, det2, seg2 = transcribe_once(
                    use_vad, force_language="hi", initial_prompt=ip
                )
                if (out2 or "").strip():
                    out, detected_language, segments_out = out2, det2, seg2

        if args.json:
            sys.stdout.write(
                json.dumps(
                    {
                        "transcript": out,
                        "language": detected_language,
                        "segments": segments_out,
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
