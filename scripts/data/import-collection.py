#!/usr/bin/env python3
"""
从 JSONL 导入到 ChromaDB collection（upsert 语义）

用法：
    python3 scripts/data/import-collection.py \
        --input scripts/data/tech_knowledge_export.jsonl \
        --collection tech_knowledge \
        --host http://localhost:8000

设计：
  - **upsert 而非 add** —— 已有 id 覆盖，新 id 插入。不会损坏服务器既有数据
  - 只动指定 collection，**不影响 long_term_memory / short_term_memory 等用户数据**
  - 自动 batch（默认 100/批），ChromaDB 写入更稳
  - 用本地预计算好的 embedding，**不消耗服务器侧 DashScope 配额**
"""

import argparse
import json
import os
import sys

try:
    import chromadb
except ImportError:
    print("❌ 缺少 chromadb 包：pip3 install chromadb")
    sys.exit(1)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--collection", default="tech_knowledge")
    p.add_argument("--host", default="http://localhost:8000")
    p.add_argument("--batch-size", type=int, default=100)
    return p.parse_args()


def main():
    args = parse_args()

    if not os.path.exists(args.input):
        print(f"❌ 输入文件不存在: {args.input}")
        sys.exit(1)

    size_mb = os.path.getsize(args.input) / 1024 / 1024
    print(f"📂 input: {args.input}  ({size_mb:.1f} MB)")

    url = args.host.replace("http://", "").replace("https://", "")
    host, port = (url.split(":") + ["8000"])[:2]
    client = chromadb.HttpClient(host=host, port=int(port))

    # get_or_create —— 服务器若已有同名 collection 不破坏
    coll = client.get_or_create_collection(args.collection)
    before = coll.count()
    print(f"📦 target collection: {args.collection}   导入前: {before} 条")

    batch_ids, batch_docs, batch_embs, batch_metas = [], [], [], []
    total_written = 0

    def flush():
        nonlocal total_written
        if not batch_ids:
            return
        # ChromaDB upsert：已有 id → 覆盖，新 id → 插入。安全。
        coll.upsert(
            ids=batch_ids,
            documents=batch_docs,
            embeddings=batch_embs if any(e is not None for e in batch_embs) else None,
            metadatas=batch_metas,
        )
        total_written += len(batch_ids)
        print(f"  upserted {total_written} ...")
        batch_ids.clear()
        batch_docs.clear()
        batch_embs.clear()
        batch_metas.clear()

    with open(args.input, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception as e:
                print(f"  ⚠️  L{line_no} JSON 解析失败，跳过: {e}")
                continue

            batch_ids.append(rec["id"])
            batch_docs.append(rec.get("document", ""))
            batch_embs.append(rec.get("embedding"))
            batch_metas.append(rec.get("metadata") or {})

            if len(batch_ids) >= args.batch_size:
                flush()

    flush()  # 收尾

    after = coll.count()
    print(f"\n✅ 导入完成   导入前: {before}   导入后: {after}   新增: {after - before}")


if __name__ == "__main__":
    main()
