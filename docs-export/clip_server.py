"""
CineRecap Visual Matching Sidecar — v1.2
Semantic frame-to-narration matching using OpenCLIP/SigLIP (CPU-only).
Default model: ViT-SO400M-14-SigLIP2 (webli), with ViT-B-32/openai fallback.
Uses open_clip_torch which downloads models in safetensors format, avoiding
the CVE-2025-32434 vulnerability that affects torch.load with pytorch_model.bin.

Endpoints:
  GET  /health                       readiness + model status
  POST /embed-job                    embed all frames for one analyze job (idempotent)
  POST /match                        find best-matching frame timestamp per narration text
  DELETE /embed-job/{job_id}         release stored embeddings
"""
import os
import time
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="[clip] %(message)s")
log = logging.getLogger("clip")

MODEL_CACHE_DIR = os.environ.get("MODEL_CACHE_DIR", "/data/models")
os.makedirs(MODEL_CACHE_DIR, exist_ok=True)

VISUAL_MODEL_NAME = os.environ.get("VISUAL_MODEL_NAME", os.environ.get("CLIP_MODEL_NAME", "ViT-SO400M-14-SigLIP2"))
VISUAL_MODEL_PRETRAINED = os.environ.get("VISUAL_MODEL_PRETRAINED", os.environ.get("CLIP_PRETRAINED", "webli"))
FALLBACK_MODEL_NAME = os.environ.get("VISUAL_FALLBACK_MODEL_NAME", "ViT-B-32")
FALLBACK_MODEL_PRETRAINED = os.environ.get("VISUAL_FALLBACK_PRETRAINED", "openai")

log.info(f"Loading visual matcher {VISUAL_MODEL_NAME} ({VISUAL_MODEL_PRETRAINED}) on CPU...")
_t0 = time.time()

import torch
import numpy as np
from PIL import Image
import open_clip

_model = None
_preprocess = None
_tokenizer = None
_model_name_loaded = None
_pretrained_loaded = None


def _load_visual_model(model_name: str, pretrained: str):
    model, _, preprocess = open_clip.create_model_and_transforms(
        model_name,
        pretrained=pretrained,
        cache_dir=MODEL_CACHE_DIR,
        device="cpu",
    )
    tokenizer = open_clip.get_tokenizer(model_name)
    model.eval()
    return model, preprocess, tokenizer

try:
    _model, _preprocess, _tokenizer = _load_visual_model(VISUAL_MODEL_NAME, VISUAL_MODEL_PRETRAINED)
    _model_name_loaded = VISUAL_MODEL_NAME
    _pretrained_loaded = VISUAL_MODEL_PRETRAINED
    log.info(f"Visual matcher loaded: {_model_name_loaded}/{_pretrained_loaded} in {time.time() - _t0:.1f}s")
except Exception as _exc:
    log.error(f"Visual matcher load failed for {VISUAL_MODEL_NAME}/{VISUAL_MODEL_PRETRAINED}: {_exc}")
    try:
        log.info(f"Falling back to {FALLBACK_MODEL_NAME}/{FALLBACK_MODEL_PRETRAINED}...")
        _model, _preprocess, _tokenizer = _load_visual_model(FALLBACK_MODEL_NAME, FALLBACK_MODEL_PRETRAINED)
        _model_name_loaded = FALLBACK_MODEL_NAME
        _pretrained_loaded = FALLBACK_MODEL_PRETRAINED
        log.info(f"Fallback visual matcher loaded: {_model_name_loaded}/{_pretrained_loaded} in {time.time() - _t0:.1f}s")
    except Exception as _fallback_exc:
        log.error(f"Fallback visual matcher load failed — sidecar running in degraded mode: {_fallback_exc}")

_store: dict = {}

app = FastAPI(title="CineRecap Visual Matching Sidecar", version="1.2.0")


class FrameItem(BaseModel):
    path: str
    timeSec: float


class EmbedJobRequest(BaseModel):
    jobId: str
    frames: List[FrameItem]


class MatchRequest(BaseModel):
    jobId: str
    texts: List[str]


def _embed_image(path_str: str) -> Optional[np.ndarray]:
    try:
        img = _preprocess(Image.open(path_str).convert("RGB")).unsqueeze(0)
        with torch.no_grad():
            feat = _model.encode_image(img)
        return feat[0].numpy().astype(np.float32)
    except Exception as exc:
        log.warning(f"image embed fail ({Path(path_str).name}): {exc}")
        return None


def _embed_text(text: str) -> Optional[np.ndarray]:
    try:
        tokens = _tokenizer([text[:300]])
        with torch.no_grad():
            feat = _model.encode_text(tokens)
        return feat[0].numpy().astype(np.float32)
    except Exception as exc:
        log.warning(f"text embed fail: {exc}")
        return None


@app.get("/health")
def health():
    return {"ok": True, "model": _model is not None, "modelName": _model_name_loaded, "pretrained": _pretrained_loaded, "jobs": len(_store)}


@app.post("/embed-job")
def embed_job(req: EmbedJobRequest):
    if _model is None:
        raise HTTPException(503, "visual matching model not loaded")
    if req.jobId in _store:
        return {"jobId": req.jobId, "frames": len(_store[req.jobId]), "cached": True}

    t0 = time.time()
    entries = []
    for f in req.frames:
        if not Path(f.path).exists():
            log.warning(f"frame not found: {f.path}")
            continue
        emb = _embed_image(f.path)
        if emb is not None:
            entries.append({"timeSec": f.timeSec, "embedding": emb})

    _store[req.jobId] = entries
    log.info(f"embed-job {req.jobId}: {len(entries)}/{len(req.frames)} frames in {time.time()-t0:.1f}s")
    return {"jobId": req.jobId, "frames": len(entries), "cached": False}


@app.post("/match")
def match(req: MatchRequest):
    if _model is None:
        raise HTTPException(503, "visual matching model not loaded")
    entries = _store.get(req.jobId)
    if not entries:
        raise HTTPException(404, f"No embeddings for job {req.jobId}")

    frame_embs = np.stack([e["embedding"] for e in entries])
    frame_norms = np.linalg.norm(frame_embs, axis=1, keepdims=True) + 1e-8
    frame_times = [e["timeSec"] for e in entries]
    normed_frames = frame_embs / frame_norms

    results = []
    for text in req.texts:
        text_emb = _embed_text(text)
        if text_emb is None:
            mid = len(entries) // 2
            results.append({"timeSec": float(frame_times[mid]), "score": 0.0})
            continue
        text_norm = np.linalg.norm(text_emb) + 1e-8
        sims = normed_frames @ (text_emb / text_norm)
        best_idx = int(np.argmax(sims))
        results.append({"timeSec": float(frame_times[best_idx]), "score": float(sims[best_idx])})

    return {"results": results}


@app.delete("/embed-job/{job_id}")
def delete_embed_job(job_id: str):
    removed = _store.pop(job_id, None)
    return {"removed": removed is not None, "jobId": job_id}
