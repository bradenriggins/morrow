#!/usr/bin/env python3
"""Bind the GitHub artifact, then validate all ZIP members before extraction."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import stat
import zipfile


def select_artifact(records, source, run):
    if not re.fullmatch(r"[0-9a-f]{40}", source) or not re.fullmatch(r"[1-9][0-9]*", run):
        raise ValueError("artifact_source_invalid")
    matches = [item for item in records["artifacts"] if item["name"] == "morrow-macos-desktop-" + run]
    if len(matches) != 1:
        raise ValueError("unique_qa_artifact_required")
    item = matches[0]
    if (item["expired"] or item["workflow_run"]["id"] != int(run)
            or item["workflow_run"]["head_sha"] != source
            or type(item["id"]) is not int or item["id"] < 1
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", item.get("digest", ""))
            or not 0 < item["size_in_bytes"] <= 512 * 1024 * 1024):
        raise ValueError("artifact_binding_invalid")
    return item


def extract_artifact(archive, destination, metadata):
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if archive.stat().st_size != metadata["size_in_bytes"] or "sha256:" + digest.hexdigest() != metadata["digest"]:
        raise ValueError("artifact_archive_digest_mismatch")
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        names = set()
        total = 0
        if not 1 <= len(members) <= 64:
            raise ValueError("artifact_member_count_invalid")
        for member in members:
            name = member.filename
            kind = stat.S_IFMT(member.external_attr >> 16)
            if (not name or "/" in name or "\\" in name or ":" in name or "\x00" in name
                    or name in (".", "..") or name in names or member.is_dir()
                    or pathlib.Path(name).suffix not in (".dmg", ".zip", ".json")
                    or kind not in (0, stat.S_IFREG) or member.flag_bits & 1):
                raise ValueError("artifact_member_unsafe")
            names.add(name)
            total += member.file_size
            if total > 1024 * 1024 * 1024:
                raise ValueError("artifact_expanded_size_invalid")
        destination.mkdir(mode=0o700)
        try:
            for member in members:
                with package.open(member) as source, (destination / member.filename).open("xb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
        except BaseException:
            shutil.rmtree(destination)
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("select", "extract"))
    parser.add_argument("--metadata", required=True, type=pathlib.Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--archive", type=pathlib.Path)
    parser.add_argument("--destination", type=pathlib.Path)
    args = parser.parse_args()
    artifact = select_artifact(json.loads(args.metadata.read_text()), args.source, args.run)
    if args.mode == "select":
        print(artifact["id"])
    else:
        if args.archive is None or args.destination is None:
            parser.error("extract requires --archive and --destination")
        extract_artifact(args.archive, args.destination, artifact)


if __name__ == "__main__":
    main()
