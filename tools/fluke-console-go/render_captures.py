"""Render recorded native VT cells; these are application captures, not mockups."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).parent / "captures"
font = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", 16)
bold_font = ImageFont.truetype(r"C:\Windows\Fonts\consolab.ttf", 16)
palette = [(0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),
           (188,63,188),(17,168,205),(229,229,229),(102,102,102),(241,76,76),
           (35,209,139),(245,245,67),(59,142,234),(214,112,214),(41,184,219),(255,255,255)]

def color(value, foreground):
    if value >= 1 << 24:
        return (238,234,250) if foreground else (11,6,25)
    if value < 16:
        return palette[value]
    if value < 232:
        n = value - 16
        levels = [0,95,135,175,215,255]
        return levels[n//36], levels[n//6%6], levels[n%6]
    if value < 256:
        return (8+(value-232)*10,)*3
    return value>>16&255, value>>8&255, value&255

for path in root.glob("go-*.json"):
    data = json.loads(path.read_text(encoding="utf-8"))
    picture = Image.new("RGB", (data["Cols"]*10+24, data["Rows"]*20+24), (11,6,25))
    draw = ImageDraw.Draw(picture)
    for cell in data["Cells"]:
        x, y = 12+cell["X"]*10, 12+cell["Y"]*20
        fg, bg = color(cell["FG"], True), color(cell["BG"], False)
        if cell["Mode"] & 1:
            fg, bg = bg, fg
        draw.rectangle((x,y,x+9,y+19), fill=bg)
        draw.text((x,y), cell["Text"].replace("\0"," "), font=bold_font if cell["Mode"] & 4 else font, fill=fg)
    picture.save(path.with_suffix(".png"))
    print(path.with_suffix(".png"))
