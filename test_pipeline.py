import pytest

def test_config_loads():
    try:
        from server.config_loader import AppConfig
        cfg = AppConfig.load().data
        assert "embeddings" in cfg and "vectorstore" in cfg
    except ModuleNotFoundError:
        pytest.skip("config_loader not available in this slim server build")

def test_embed_roundtrip(tmp_path):
    try:
        from server.embeddings.factory import EmbeddingFactory
        from server.vectorstores.faiss_store import FAISSStore
    except ModuleNotFoundError:
        pytest.skip("embeddings/vectorstore not available in this repo snapshot")
    E = EmbeddingFactory("sentence-transformers/all-MiniLM-L6-v2")
    VS = FAISSStore(str(tmp_path)); VS.load(E.encode(["x"]).shape[1])
    VS.add(E.encode(["hello"]), [{"text":"hello"}])
    hits = VS.search(E.encode(["hello"]), k=1)
    assert hits and VS.get(hits[0][0])["text"] == "hello"
