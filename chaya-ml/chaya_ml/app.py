"""
FastAPI app aligned with chaya-engine internal/harness/capability/rag/embedder.go embedSidecar:
POST /embed JSON {"texts": ["..."]} -> {"embeddings": [[float32, ...], ...]}
"""

import logging
import os
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Same default as legacy chaya/backend embedding_service.py LOCAL_MODELS["local"]
DEFAULT_MODEL_ID = os.environ.get(
    "CHAYA_ML_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)

_model = None


def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        logger.info("loading sentence-transformers model: %s", DEFAULT_MODEL_ID)
        _model = SentenceTransformer(DEFAULT_MODEL_ID)
    return _model


app = FastAPI(title="chaya-ml", version="0.1.0")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(default_factory=list)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dims: int


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "model": DEFAULT_MODEL_ID}


@app.post("/embed", response_model=EmbedResponse)
def embed(body: EmbedRequest) -> EmbedResponse:
    if not body.texts:
        return EmbedResponse(embeddings=[], model=DEFAULT_MODEL_ID, dims=0)
    model = get_model()
    vectors = model.encode(
        body.texts,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    # float32 lists for JSON
    out: list[list[float]] = [v.astype("float32").tolist() for v in vectors]
    dims = len(out[0]) if out else 0
    return EmbedResponse(embeddings=out, model=DEFAULT_MODEL_ID, dims=dims)
