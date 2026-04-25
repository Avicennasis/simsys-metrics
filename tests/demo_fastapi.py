"""Tiny FastAPI demo app used by tests and the conformance script."""

from __future__ import annotations

from fastapi import FastAPI

from simsys_metrics import install, track_job, track_queue

app = FastAPI()
install(app, service="demo", version="0.1.0")

_queue = [1, 2, 3]
track_queue("demo_q", depth_fn=lambda: len(_queue))


@app.get("/")
def index():
    return {"ok": True}


@app.get("/items/{item_id}")
def item(item_id: int):
    return {"id": item_id}


@app.get("/boom")
def boom():
    raise RuntimeError("intentional")


@app.get("/work")
def work():
    @track_job("demo_job")
    def _do():
        return "done"

    return {"result": _do()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
