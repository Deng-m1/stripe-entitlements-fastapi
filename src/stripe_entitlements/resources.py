from __future__ import annotations

from importlib.resources import files
from pathlib import Path


def _resource_path(name: str) -> Path:
    packaged = files("stripe_entitlements").joinpath(name)
    if packaged.is_file() or packaged.is_dir():
        return Path(str(packaged))
    repository = Path(__file__).resolve().parents[2] / name
    if repository.exists():
        return repository
    raise FileNotFoundError(f"bundled project resource is missing: {name}")


def default_plan_catalog_path() -> str:
    return str(_resource_path("plans.toml"))


def default_migration_directory() -> Path:
    return _resource_path("migrations")
