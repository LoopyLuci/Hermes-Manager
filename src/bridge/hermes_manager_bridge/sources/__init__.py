from __future__ import annotations

from ..models import SOURCE_LAYERS, LayerStatus, SourceLayer
from ..runtime import HermesRuntime
from . import cli, db, deep, files, rest

PROBES = {
    "rest": rest.probe,
    "files": files.probe,
    "db": db.probe,
    "cli": cli.probe,
    "deep": deep.probe,
}

DOMAIN_PREFERENCES: dict[str, tuple[SourceLayer, ...]] = {
    "overview": ("rest", "deep", "files"),
    "logs": ("files", "rest"),
    "gateway": ("deep", "rest", "cli"),
    "sessions": ("db", "rest"),
    "chat": ("cli", "rest"),
    "updates": ("deep", "files"),
    "backups": ("deep", "files"),
    "config": ("deep", "files"),
    "tools": ("deep", "files"),
}


def probe_all(runtime: HermesRuntime) -> dict[SourceLayer, LayerStatus]:
    return {layer: PROBES[layer](runtime) for layer in SOURCE_LAYERS}


def resolve_domains(layers: dict[SourceLayer, LayerStatus]) -> dict[str, SourceLayer]:
    domains: dict[str, SourceLayer] = {}
    for domain, preferences in DOMAIN_PREFERENCES.items():
        chosen = next(
            (layer for layer in preferences if layers[layer].state != "unavailable"),
            preferences[0],
        )
        domains[domain] = chosen
    return domains
