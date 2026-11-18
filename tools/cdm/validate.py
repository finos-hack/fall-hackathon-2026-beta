"""Validates Interlock's CDM objects with CDM's own tooling (finos-cdm, pinned in requirements.txt).

Usage: python -I tools/cdm/validate.py <file.json | directory> ...
Each file holds one CDM object, or {"objects": [{"name": ..., "object": {...}}, ...]}. Every object is
deserialized with Rune (attribute types) and its Rune conditions are checked. Exit status 1 if any object fails.

Two workarounds for finos-cdm 7.10.0, both reported in docs/cdm-mapping.md:
  - the package's bundle must be imported before any model module, or imports fail on circular references;
  - some validators are built while fields are still typed None (e.g. PrimitiveInstruction.transfer,
    Identifier.assignedIdentifier), so every model of the bundle is rebuilt before use (about 10 seconds).
"""
import json
import os
import sys

import importlib

import pydantic

import finos._bundle  # noqa: F401  (must come first: see above)
from finos.cdm.event.common.TransferInstruction import TransferInstruction


def rebuild_models():
    """Rebuilds every model of the bundle (twice, bottom-up order is not known) and the ones Interlock uses."""
    bundle = finos._bundle
    models = [m for m in (getattr(bundle, n) for n in dir(bundle)) if isinstance(m, type) and issubclass(m, pydantic.BaseModel)]
    for name in (
        "finos.cdm.event.common.TransferInstruction",
        "finos.cdm.event.common.TransferState",
        "finos.cdm.event.common.UnscheduledTransfer",
        "finos.cdm.base.staticdata.identifier.AssignedIdentifier",
    ):
        models.append(getattr(importlib.import_module(name), name.rsplit(".", 1)[1]))
    for _ in range(2):
        for m in models:
            try:
                m.model_rebuild(force=True)
            except Exception:  # pylint: disable=broad-except
                pass


rebuild_models()

TYPES = {"cdm.event.common.TransferInstruction": TransferInstruction}


def objects_in(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "objects" in data:
        for o in data["objects"]:
            yield f"{os.path.basename(path)}:{o['name']}", o["object"]
    else:
        yield os.path.basename(path), data


def files(args):
    for a in args:
        if os.path.isdir(a):
            for n in sorted(os.listdir(a)):
                if n.endswith(".json"):
                    yield os.path.join(a, n)
        else:
            yield a


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    failed = 0
    total = 0
    for path in files(argv):
        for name, obj in objects_in(path):
            total += 1
            cls = TYPES.get(obj.get("@type"))
            if cls is None:
                failed += 1
                print(f"ERR {name}: unsupported @type {obj.get('@type')!r}")
                continue
            try:
                cls.rune_deserialize(json.dumps(obj), validate_model=True, check_rune_constraints=True)
                print(f"OK  {name}")
            except Exception as e:  # pylint: disable=broad-except
                failed += 1
                first = str(e).strip().splitlines()[0][:300]
                print(f"ERR {name}: {type(e).__name__}: {first}")
    print(f"{total - failed} of {total} CDM objects valid (finos-cdm {cdm_version()})")
    return 1 if failed else 0


def cdm_version():
    try:
        from importlib.metadata import version
        return version("finos-cdm")
    except Exception:  # pylint: disable=broad-except
        return "unknown"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
