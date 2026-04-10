import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("CHAYA_ML_PORT", "8100"))
    uvicorn.run(
        "chaya_ml.app:app",
        host=os.environ.get("CHAYA_ML_HOST", "0.0.0.0"),
        port=port,
        reload=False,
    )
