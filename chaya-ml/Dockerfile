FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
  "fastapi>=0.115.0" \
  "uvicorn[standard]>=0.32.0" \
  "sentence-transformers>=3.0.0" \
  "torch>=2.2.0"

COPY chaya_ml ./chaya_ml

ENV PYTHONPATH=/app
ENV CHAYA_ML_HOST=0.0.0.0
ENV CHAYA_ML_PORT=8100

EXPOSE 8100

CMD ["python", "-m", "uvicorn", "chaya_ml.app:app", "--host", "0.0.0.0", "--port", "8100"]
