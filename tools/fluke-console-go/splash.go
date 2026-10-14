package main

import (
	"image/color"
	"math"
	"strings"

	"charm.land/lipgloss/v2"
)

var splashInks = []color.Color{
	ground, lipgloss.Color("#574084"), lipgloss.Color("#247d8f"),
	cyan, lipgloss.Color("#a2fbff"), lipgloss.Color("#eeeafa"),
}

// Every frame comes from terminal cells; no assets, child processes or random state.
func splashMark(w, h, frame int) string {
	w, h = min(84, max(1, w)), max(1, h)
	type cell struct {
		glyph rune
		ink   int
	}
	cells := make([]cell, w*h)
	put := func(x, y int, glyph rune, ink int) {
		if x >= 0 && x < w && y >= 0 && y < h {
			cells[y*w+x] = cell{glyph, ink}
		}
	}
	for i := 0; i < w*h/110; i++ {
		put((i*37+11)%w, (i*17+3)%h, '.', 1)
	}
	phase := float64(frame) * math.Pi / 32
	angle := math.Sin(phase) * .055
	scale := float64(h) / 83
	// Sample the silhouette into a mask so density reflects the edge, rather than flickering randomly.
	mask := make([]bool, w*h)
	for _, point := range flukeLogoPoints {
		x, y := point[0]*100-50, point[1]*100-50
		rx, ry := x*math.Cos(angle)-y*math.Sin(angle), x*math.Sin(angle)+y*math.Cos(angle)
		px := int(math.Round(float64(w-1)/2 + rx*scale*2 + math.Sin(phase)*.5))
		py := int(math.Round(float64(h-1)/2 + (ry+1)*scale))
		if px >= 0 && px < w && py >= 0 && py < h {
			mask[py*w+px] = true
		}
	}
	glyphs := []rune("+*#@")
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if !mask[y*w+x] {
				continue
			}
			density := 0
			for _, offset := range [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
				px, py := x+offset[0], y+offset[1]
				if px >= 0 && px < w && py >= 0 && py < h && mask[py*w+px] {
					density++
				}
			}
			if density < 3 {
				put(x, y, []rune("·.:")[(x+y)%3], 2)
			} else {
				put(x, y, glyphs[(x*3+y*5)/3%len(glyphs)], 3)
			}
		}
	}
	var out strings.Builder
	for y := 0; y < h; y++ {
		for x := 0; x < w; {
			ink := cells[y*w+x].ink
			var run strings.Builder
			for x < w && cells[y*w+x].ink == ink {
				glyph := cells[y*w+x].glyph
				if glyph == 0 {
					glyph = ' '
				}
				run.WriteRune(glyph)
				x++
			}
			out.WriteString(accent(run.String(), splashInks[ink]))
		}
		if y < h-1 {
			out.WriteByte('\n')
		}
	}
	return out.String()
}

func splashWordmark(w, frame int) string {
	if w < 29 {
		return strong("fluke", cyan)
	}
	beam := math.Mod(float64(frame)*.55, 47) - 7
	var rows []string
	for y, line := range brandLogo {
		runes := []rune(line)
		var row strings.Builder
		for x := 0; x < len(runes); {
			ink := 3
			distance := math.Abs(float64(x) + float64(y)*.4 - beam)
			if distance < .8 {
				ink = 5
			} else if distance < 1.7 {
				ink = 4
			}
			end := x + 1
			for end < len(runes) {
				next := 3
				d := math.Abs(float64(end) + float64(y)*.4 - beam)
				if d < .8 {
					next = 5
				} else if d < 1.7 {
					next = 4
				}
				if next != ink {
					break
				}
				end++
			}
			row.WriteString(strong(string(runes[x:end]), splashInks[ink]))
			x = end
		}
		rows = append(rows, row.String())
	}
	return strings.Join(rows, "\n")
}

// Cubic coordinates are copied from packages/public/fluke-icon.svg.
var flukeLogoPoints = func() [][2]float64 {
	curves := [][4][2]float64{
		{{50, 86}, {26, 77}, {6, 53}, {4, 21}},
		{{4, 21}, {3, 12}, {11, 10}, {19, 18}},
		{{19, 18}, {36, 36}, {47, 57}, {50, 70}},
		{{50, 70}, {53, 57}, {64, 36}, {81, 18}},
		{{81, 18}, {89, 10}, {97, 12}, {96, 21}},
		{{96, 21}, {94, 53}, {74, 77}, {50, 86}},
	}
	var outline, points [][2]float64
	for _, curve := range curves {
		for i := 0; i < 24; i++ {
			t := float64(i) / 24
			u := 1 - t
			outline = append(outline, [2]float64{
				u*u*u*curve[0][0] + 3*u*u*t*curve[1][0] + 3*u*t*t*curve[2][0] + t*t*t*curve[3][0],
				u*u*u*curve[0][1] + 3*u*u*t*curve[1][1] + 3*u*t*t*curve[2][1] + t*t*t*curve[3][1],
			})
		}
	}
	for y := 12.; y < 87; y += 2 {
		for x := 3.; x < 98; x += 2 {
			inside := false
			for i, a := range outline {
				b := outline[(i+1)%len(outline)]
				if (a[1] > y) != (b[1] > y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0] {
					inside = !inside
				}
			}
			if inside {
				points = append(points, [2]float64{x / 100, y / 100})
			}
		}
	}
	return points
}()
