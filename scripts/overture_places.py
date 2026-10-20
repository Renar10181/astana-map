"""Заведения Астаны из Overture Maps Places -> компактный JSON для поиска на карте.

Запуск (делает GitHub Actions раз в месяц):
  overturemaps download --bbox=71.20,50.95,71.75,51.30 -f geojson --type=place -o places.geojson
  python scripts/overture_places.py places.geojson data/places-astana.json

Формат строки: [lng, lat, name, category, address, phone, website, source]
Лицензии: Meta, Microsoft, PinMeTo — CDLA-Permissive-2.0; Foursquare — Apache-2.0; AllThePlaces — CC0-1.0.
"""
import json
import sys


def val(x):
    """Поле может прийти и объектом, и JSON-строкой."""
    if isinstance(x, str):
        s = x.strip()
        if s[:1] in "[{":
            try:
                return json.loads(s)
            except ValueError:
                return x
    return x


def first(lst):
    lst = val(lst)
    if isinstance(lst, list) and lst:
        return lst[0]
    return None


def main(src, dst):
    with open(src, encoding="utf-8") as f:
        fc = json.load(f)
    out, seen = [], set()
    for ft in fc.get("features", []):
        g = ft.get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lng, lat = g["coordinates"][:2]
        p = ft.get("properties") or {}
        names = val(p.get("names")) or {}
        name = (names.get("primary") if isinstance(names, dict) else None) or ""
        name = name.strip()
        if not name or len(name) > 80:
            continue
        sources = val(p.get("sources")) or []
        datasets = {s.get("dataset", "") for s in sources if isinstance(s, dict)}
        conf = p.get("confidence") or 0
        # как у Айналмы: для данных Meta порог уверенности 0,7, остальные источники без порога
        if datasets <= {"meta"} and conf < 0.7:
            continue
        cats = val(p.get("categories")) or {}
        cat = (cats.get("primary") if isinstance(cats, dict) else None) or ""
        addr = first(p.get("addresses")) or {}
        addr = addr.get("freeform", "") if isinstance(addr, dict) else ""
        phone = first(p.get("phones")) or ""
        web = first(p.get("websites")) or ""
        key = (name.lower(), round(lng, 4), round(lat, 4))
        if key in seen:
            continue
        seen.add(key)
        src_name = sorted(datasets)[0] if datasets else ""
        out.append([round(lng, 6), round(lat, 6), name, cat, addr or "", phone or "", web or "", src_name])
    out.sort(key=lambda r: r[2].lower())
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"release": "overture", "count": len(out), "items": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"places: {len(out)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
