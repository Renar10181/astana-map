"""Все заведения Астаны с названием из OpenStreetMap -> компактный JSON для поиска на карте.

Запуск (делает GitHub Actions раз в неделю):
  python scripts/osm_places.py data/osm-places-astana.json

Формат строки: [lng, lat, name, category, address, phone, website, "osm", opening_hours]
Лицензия данных: © участники OpenStreetMap, ODbL 1.0.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BBOX = "50.95,71.20,51.30,71.75"   # юг, запад, север, восток
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
KEYS = ["amenity", "shop", "tourism", "leisure", "office", "craft", "healthcare", "club"]
SKIP = {"amenity": {"bench", "waste_basket", "parking_space", "bicycle_parking", "vending_machine", "parking_entrance",
                    "recycling", "waste_disposal", "shelter", "grit_bin", "loading_dock", "fountain", "clock"},
        "leisure": {"pitch", "playground", "garden", "swimming_pool", "track", "picnic_table", "outdoor_seating", "slipway"}}

# категории OSM -> те же ключи, что у Overture (переводятся в приложении)
CAT = {
    "amenity": {"cafe": "cafe", "restaurant": "restaurant", "fast_food": "fast_food_restaurant", "pharmacy": "pharmacy",
                "bank": "bank", "atm": "atm", "hospital": "hospital", "clinic": "medical_center", "doctors": "doctor",
                "dentist": "dentist", "fuel": "gas_station", "school": "school", "kindergarten": "kindergarten",
                "university": "college_university", "college": "college_university", "post_office": "post_office",
                "car_wash": "car_wash", "bar": "bar", "pub": "pub", "theatre": "theatre", "cinema": "movie_theater",
                "parking": "parking", "charging_station": "ev_charging_station", "veterinary": "veterinarian",
                "library": "library", "police": "police", "townhall": "government_office", "toilets": "toilet",
                "marketplace": "market", "car_rental": "car_rental", "driving_school": "driving_school",
                "nightclub": "night_club", "community_centre": "community_center", "events_venue": "event_venue",
                "bureau_de_change": "currency_exchange", "money_transfer": "money_transfer", "food_court": "food_court",
                "arts_centre": "arts_center", "courthouse": "court", "embassy": "embassy", "notary": "notary"},
    "shop": {"supermarket": "supermarket", "convenience": "convenience_store", "clothes": "clothing_store",
             "shoes": "shoe_store", "mall": "shopping_center", "department_store": "shopping_center",
             "hairdresser": "hair_salon", "beauty": "beauty_salon", "florist": "florist", "electronics": "electronics_store",
             "mobile_phone": "mobile_phone_store", "furniture": "furniture_store", "hardware": "hardware_store",
             "doityourself": "hardware_store", "car_repair": "automotive_repair", "car_parts": "auto_parts_store",
             "tyres": "tire_shop", "bakery": "bakery", "pet": "pet_store", "laundry": "laundry",
             "dry_cleaning": "dry_cleaning", "car": "car_dealer", "optician": "optician", "jewelry": "jewelry_store",
             "books": "bookstore", "cosmetics": "cosmetics_store", "toys": "toy_store", "sports": "sporting_goods",
             "butcher": "butcher", "alcohol": "liquor_store", "gift": "gift_shop", "copyshop": "print_shop",
             "computer": "computer_store", "kiosk": "kiosk", "chemist": "drugstore", "medical_supply": "medical_supply"},
    "tourism": {"hotel": "hotel", "hostel": "hostel", "museum": "museum", "attraction": "attraction",
                "guest_house": "guest_house", "apartment": "apartment_rental", "gallery": "art_gallery"},
    "leisure": {"fitness_centre": "fitness_center", "sports_centre": "sports_center", "park": "park",
                "water_park": "water_park", "stadium": "stadium", "ice_rink": "ice_rink", "bowling_alley": "bowling_alley",
                "dog_park": "dog_park"},
}


def fetch():
    keys = "".join(f'nwr["name"]["{k}"]({BBOX});' for k in KEYS)
    q = f"[out:json][timeout:180];({keys});out center tags;"
    data = urllib.parse.urlencode({"data": q}).encode()
    for attempt in range(3):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "astana-map (github.com/Renar10181/astana-map)"})
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.load(r)["elements"]
            except Exception as e:  # пробуем следующий сервер
                print("overpass fail", url, e)
        time.sleep(30)
    raise SystemExit("Overpass недоступен")


def category(t):
    for k in KEYS:
        v = t.get(k)
        if not v:
            continue
        if v in SKIP.get(k, ()):
            return None
        if k == "amenity" and v == "place_of_worship":
            return {"muslim": "mosque", "christian": "church"}.get(t.get("religion"), "place_of_worship")
        return CAT.get(k, {}).get(v) or (f"{k}_{v}" if k in ("office", "craft", "healthcare") else v)
    return None


def main(dst):
    els = fetch()
    print("elements:", len(els))
    out, seen = [], set()
    for e in els:
        t = e.get("tags") or {}
        lng = e.get("lon") or (e.get("center") or {}).get("lon")
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        name = (t.get("name:ru") or t.get("name") or "").replace("\n", " ").strip()
        if lng is None or not name or len(name) > 80:
            continue
        cat = category(t)
        if not cat:
            continue
        key = (name.lower(), round(lng, 3), round(lat, 3))
        if key in seen:
            continue
        seen.add(key)
        addr = ", ".join(x for x in [t.get("addr:street"), t.get("addr:housenumber")] if x)
        phone = (t.get("phone") or t.get("contact:phone") or t.get("contact:mobile") or "").split(";")[0].strip()
        web = t.get("website") or t.get("contact:website") or t.get("contact:instagram") or ""
        out.append([round(lng, 6), round(lat, 6), name, cat, addr, phone, web, "osm", t.get("opening_hours", "")])
    out.sort(key=lambda r: r[2])
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"source": "OpenStreetMap, ODbL", "updated": time.strftime("%Y-%m-%d"), "count": len(out), "items": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    print("saved:", len(out))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/osm-places-astana.json")
