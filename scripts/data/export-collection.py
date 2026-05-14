#!/usr/bin/env python3
"""
导出 ChromaDB collection 为 JSONL（含 id / document / embedding / metadata）

用法：
    python3 scripts/data/export-collection.py \
        --collection tech_knowledge \
        --output scripts/data/tech_knowledge_export.jsonl \
        --host http://localhost:8000

设计：
  - 只导单个 collection（默认 tech_knowledge），不动其他
  - 分页拉（每批 500），避免一次性占大内存
  - JSONL 行式 —— 大文件传输/恢复更稳，断点续传友好
"""

import argparse
import json
import os
import sys

try:
    import chromadb
except ImportError:
    print("❌ 缺少 chromadb 包，先装：pip3 install chromadb")
    sys.exit(1)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--collection", default="tech_knowledge", help="collection name")
    p.add_argument("--output", default="scripts/data/tech_knowledge_export.jsonl")
    p.add_argument("--host", default="http://localhost:8000")
    p.add_argument("--batch-size", type=int, default=500)
    return p.parse_args()


def main():
    args = parse_args()

    # ChromaDB 1.x HttpClient
    url = args.host.replace("http://", "").replace("https://", "")
    host, port = (url.split(":") + ["8000"])[:2]
    client = chromadb.HttpClient(host=host, port=int(port))

    coll = client.get_collection(args.collection)
    total = coll.count()
    print(f"📦 collection: {args.collection}   total: {total} 条")
    if total == 0:
        print("⚠️  空 collection，不导")
        return

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    f = open(args.output, "w", encoding="utf-8")

    written = 0
    offset = 0
    while offset < total:
        batch = coll.get(
            limit=args.batch_size,
            offset=offset,
            include=["documents", "embeddings", "metadatas"],
        )
        # ChromaDB 把 embeddings 返成 numpy ndarray，不能用 `or` 取默认值
        ids = batch.get("ids") if batch.get("ids") is not None else []
        docs = batch.get("documents") if batch.get("documents") is not None else []
        embs = batch.get("embeddings") if batch.get("embeddings") is not None else []
        metas = batch.get("metadatas") if batch.get("metadatas") is not None else []

        for i in range(len(ids)):
            rec = {
                "id": ids[i],
                "document": docs[i] if i < len(docs) else "",
                "embedding": list(embs[i]) if i < len(embs) and embs[i] is not None else None,
                "metadata": metas[i] if i < len(metas) else {},
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            written += 1

        offset += args.batch_size
        print(f"  exported {written}/{total} ({written * 100 // max(total, 1)}%)")

    f.close()

    size_mb = os.path.getsize(args.output) / 1024 / 1024
    print(f"\n✅ 导出完成 {written} 条 → {args.output}  ({size_mb:.1f} MB)")
    print(f"\n下一步：scp 到服务器后运行 import-collection.py")


if __name__ == "__main__":
    main()
