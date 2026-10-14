package main

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"

	"charm.land/lipgloss/v2"
)

func (m *model) setupView() string {
	p := &m.setup
	w, h := max(1, m.width), max(1, m.height)
	inside := max(1, w-8)
	if p.step == 0 {
		artH := min(16, max(3, h-23))
		parts := []string{splashMark(inside, artH, p.frame), "", splashWordmark(inside, p.frame), "",
			strong(setupSignalText(localText("YOUR PROJECT. IN MOTION.", "TU PROYECTO. EN MARCHA."), p.frame), lime),
			localText("One conversation. A plan. A crew that gets it done.", "Una conversación. Un plan. Un equipo que lo lleva adelante."), "",
			strong(localText("[ ENTER ]  START", "[ ENTER ]  COMENZAR"), pink),
			m.setupScanLabel(),
		}
		if h < 30 {
			parts = []string{splashWordmark(inside, p.frame), "", strong(localText("[ ENTER ]  START", "[ ENTER ]  COMENZAR"), pink), m.setupScanLabel()}
		}
		for i := range parts {
			parts[i] = wrap(parts[i], inside)
		}
		body := lipgloss.NewStyle().Width(inside).Align(lipgloss.Center).Render(lipgloss.JoinVertical(lipgloss.Center, parts...))
		keys := localText("[Enter] Start  [Ctrl+L] English / Español", "[Enter] Comenzar  [Ctrl+L] English / Español")
		return m.setupFrame(localText("FLUKE / INITIAL SETUP", "FLUKE / CONFIGURACIÓN INICIAL"), body, keys)
	}

	titles := []string{"", localText("01 / YOUR HARNESSES", "01 / TUS HARNESSES"), localText("02 / THE ORCHESTRATOR", "02 / EL ORQUESTADOR"), "03 / GITHUB", localText("04 / YOUR PROJECT", "04 / TU PROYECTO"), localText("05 / YOUR CREW", "05 / TU EQUIPO"), localText("06 / WORKSPACE READY", "06 / ESPACIO LISTO")}
	var body, keys string
	switch p.step {
	case 1:
		body = strong(localText("USE WHAT YOU ALREADY HAVE", "USÁ LO QUE YA TENÉS"), lime) + "\n" + localText("Choose the harness that will coordinate Fluke.", "Elegí el harness que coordinará Fluke.") + "\n\n" + m.setupScanLabel() + "\n\n"
		rows := []int{}
		selected := 0
		for i, h := range p.harnesses {
			if h.Executable != "" {
				if i == p.selected {
					selected = len(rows)
				}
				rows = append(rows, i)
			}
		}
		page := max(1, h-24)
		start := max(0, selected-page+1)
		for _, index := range rows[start:min(len(rows), start+page)] {
			harness := p.harnesses[index]
			marker := "  "
			ink := muted
			if index == p.selected {
				marker = "› "
				ink = pink
			}
			state := localText("detected · adapter pending", "detectado · adaptador pendiente")
			if !harness.Installed {
				state = localText("installer launcher · checking", "launcher instalador · comprobando")
			} else if harness.Usable {
				state = localText("installed · sign-in not verified", "instalado · sesión sin verificar")
				if harness.Authenticated {
					state = localText("ready · signed in", "listo · autenticado")
				} else if harness.AuthKnown {
					state = localText("installed · sign in required", "instalado · falta iniciar sesión")
				}
			}
			body += strong(marker+harness.Name, ink) + "  " + accent(state, cyan) + "\n"
		}
		if len(rows) == 0 {
			body += accent(localText("No harness found in PATH.", "No se encontró un harness en PATH."), amber) + "\n"
		}
		body += "\n" + wrap(uiText(p.reason), inside)
		body += "\n\n" + accent(wrap(localText("DeepSeek and other model providers run through a compatible harness. Detection does not imply a Fluke adapter is ready.", "DeepSeek y otros proveedores de modelos se usan mediante un harness compatible. Detectarlo no significa que su adaptador de Fluke esté listo."), inside), muted)
		keys = localText("[↑/↓ · j/k] Choose  [Enter] Continue  [R] Scan again", "[↑/↓ · j/k] Elegir  [Enter] Seguir  [R] Volver a buscar")
	case 2:
		if p.selected >= 0 && p.selected < len(p.harnesses) {
			harness := p.harnesses[p.selected]
			body = strong(harness.Name, lime) + "  " + accent(harness.Version, muted) + "\n" + wrap(uiText(harness.Message), inside) + "\n\n"
			body += strong(localText("MODEL FOR FLUKE", "MODELO PARA FLUKE"), cyan) + "\n" + wrap(uiText(harness.ModelReason), inside) + "\n\n"
			page := max(1, h-25)
			start := max(0, p.modelSelected-page+1)
			for i := start; i < len(harness.Models) && i < start+page; i++ {
				id := harness.Models[i]
				label := id
				if id == "" {
					label = localText("Use the harness setting", "Usar la configuración del harness")
				}
				marker := "  "
				ink := muted
				if i == p.modelSelected {
					marker = "› "
					ink = pink
				}
				if id != "" && id == harness.RecommendedModel {
					label += "  · " + localText("RECOMMENDED", "RECOMENDADO")
				}
				body += strong(marker+label, ink) + "\n"
			}
			if p.modelEditing {
				body += "\n" + strong(localText("MODEL ID > ", "ID MODELO > ")+p.modelDraft+"▌", pink)
			}
			body += "\n" + accent(wrap(localText("Your harness handles credentials. Model access is checked when you start a session.", "Tu harness administra las credenciales. El acceso al modelo se comprueba al iniciar una sesión."), inside), muted)
		} else {
			body = m.setupScanLabel()
		}
		keys = localText("[↑/↓ · j/k] Model  [Enter] Continue  [Ctrl+L] Sign in  [M] Model ID  [R] Refresh", "[↑/↓ · j/k] Modelo  [Enter] Seguir  [Ctrl+L] Login  [M] ID modelo  [R] Actualizar")
	case 3:
		body = strong(localText("BRING YOUR ISSUES AND PULL REQUESTS", "TRAÉ TUS ISSUES Y PULL REQUESTS"), lime) + "\n" + wrap(localText("Connect your GitHub account now, or keep working locally and connect later in Settings.", "Conectá tu cuenta de GitHub ahora, o trabajá localmente y conectala después desde Configuración."), inside) + "\n\n"
		if m.auth.Busy {
			body += accent(localText("Checking GitHub…", "Comprobando GitHub…"), cyan) + "\n"
		}
		if m.auth.Username != "" {
			body += strong(localText("CONNECTED / ", "CONECTADO / ")+m.auth.Username, lime) + "\n"
		}
		if m.auth.Error != "" {
			body += accent(wrap(uiText(m.auth.Error), inside), amber) + "\n"
		}
		if m.auth.Code != "" {
			body += "\n" + strong(m.auth.Code, pink) + "\n" + githubDevicePage + "\n" + localText("[O] Open browser · authorize this code · return here", "[O] Abrir navegador · autorizar este código · volver acá") + "\n"
		}
		connected := localText("Connect GitHub", "Conectar GitHub")
		if m.auth.Username != "" {
			connected = localText("Continue with this account", "Seguir con esta cuenta")
		}
		body += "\n" + setupChoice(connected, !p.githubLocal) + "\n" + setupChoice(localText("Continue locally", "Seguir localmente"), p.githubLocal)
		keys = localText("[Tab · ↑/↓] Choose  [Enter] Continue  [R] Refresh", "[Tab · ↑/↓] Elegir  [Enter] Seguir  [R] Actualizar")
	case 4:
		body = strong(localText("YOUR FIRST PROJECT / OPTIONAL", "TU PRIMER PROYECTO / OPCIONAL"), lime) + "\n" + wrap(localText("Open a Git repository now, or leave this blank to start with the global overview. You can create and open projects there anytime.", "Abrí un repositorio Git ahora, o dejá esto vacío para comenzar en la vista global. Ahí podés crear y abrir proyectos cuando quieras."), inside) + "\n\n"
		body += strong(localText("REPOSITORY PATH", "RUTA DEL REPOSITORIO"), cyan) + "\n" + wrap(p.repoDraft+"▌", inside) + "\n\n"
		if p.repoBusy {
			body += accent(localText("Checking repository…", "Comprobando repositorio…"), cyan)
		} else {
			body += accent(localText("~ and paths with spaces work here.", "Podés usar ~ y rutas con espacios."), muted)
		}
		keys = localText("[Enter] Continue · blank skips  [Ctrl+U] Clear path", "[Enter] Seguir · vacío saltea  [Ctrl+U] Limpiar ruta")
	case 5:
		body = strong(localText("KEEP YOUR MACHINE RESPONSIVE", "QUE TU MÁQUINA SIGA ÁGIL"), lime) + "\n" + wrap(localText("Choose the maximum number of workers running at once, shared by every project.", "Elegí el máximo de workers simultáneos, compartido por todos los proyectos."), inside) + "\n\n"
		body += strong(localText("WORKER LIMIT / ", "LÍMITE DE WORKERS / ")+p.limitDraft+"▌", pink) + "\n" + accent(fmt.Sprintf(localText("%d logical CPU cores detected", "%d núcleos lógicos de CPU detectados"), runtime.NumCPU()), muted) + "\n\n"
		body += wrap(localText("Start small. One worker owns a task from analysis to verification; more workers handle different tasks in parallel. You can change the limit in Settings.", "Empezá con pocos. Un worker lleva una tarea desde el análisis hasta la verificación; varios trabajan en tareas distintas en paralelo. Podés cambiar el límite desde Configuración."), inside)
		keys = localText("[↑/↓ · j/k] Adjust  [1–64] Limit  [Enter] Continue", "[↑/↓ · j/k] Ajustar  [1–64] Límite  [Enter] Seguir")
	case 6:
		body = strong(localText("YOUR WORKSPACE IS READY", "TU ESPACIO ESTÁ LISTO"), lime) + "\n\n"
		if a := m.state.Orchestrator; a != nil {
			body += strong(localText("ORCHESTRATOR   ", "ORQUESTADOR    "), cyan) + configLabel(a) + "\n"
		}
		project := localText("Global overview · create or open projects later", "Vista global · creá o abrí proyectos después")
		if m.repo != "" {
			project = filepath.Base(m.repo) + "\n" + accent(wrap(m.repo, inside), muted)
		}
		body += strong(localText("PROJECTS       ", "PROYECTOS      "), cyan) + project + "\n"
		github := localText("local work · connect later", "trabajo local · conectar después")
		if !p.githubLocal && m.auth.Username != "" {
			github = m.auth.Username
		}
		body += strong("GITHUB         ", cyan) + github + "\n" + strong(localText("WORKERS        ", "WORKERS        "), cyan) + fmt.Sprint(m.state.MaxWorkers) + "\n\n"
		body += wrap(localText("Tell Fluke what you want to achieve. Agree on scope, let it prepare the plan and coordinate workers, then review the result.", "Contale a Fluke qué querés lograr. Acordá el alcance, dejalo preparar el plan y coordinar workers, y después revisá el resultado."), inside) + "\n\n"
		body += strong(localText("YOU DECIDE THE IMPORTANT PARTS.", "VOS DECIDÍS LO IMPORTANTE."), pink) + "\n" + wrap(localText("Scope changes and merging your work require your decision.", "Los cambios de alcance y la integración de tu trabajo requieren tu decisión."), inside)
		keys = localText("[Enter] Open Fluke", "[Enter] Abrir Fluke")
	}
	return m.setupFrame(titles[p.step], body, keys+"  "+localText("[Esc] Back", "[Esc] Atrás"))
}

func setupChoice(label string, selected bool) string {
	if selected {
		return strong("› "+label, pink)
	}
	return accent("  "+label, muted)
}

func (m *model) setupScanLabel() string {
	p := &m.setup
	if p.scanning && p.total == 0 {
		return accent(localText("SCANNING / finding your installed tools…", "DETECTANDO / buscando tus herramientas instaladas…"), cyan)
	}
	if p.scanning {
		return accent(fmt.Sprintf(localText("SCANNING / %d of %d checks complete", "DETECTANDO / %d de %d comprobaciones listas"), p.checked, p.total), cyan)
	}
	return accent(fmt.Sprintf(localText("%d harnesses checked · local discovery complete", "%d harnesses comprobados · detección local completa"), p.checked), cyan)
}

func (m *model) setupFrame(title, body, keys string) string {
	w, h := max(1, m.width), max(1, m.height)
	contentH := max(1, h-8)
	title = setupSignalText(title, m.setup.frame)
	content := frame(title, body, w, contentH, pink, true)
	interference := m.setup.frame%96 == 70 || m.setup.frame%96 == 72
	if interference && w >= 4 && contentH >= 4 {
		rows := strings.Split(content, "\n")
		rows[0] = accent("┏"+strings.Repeat("─", w-2)+"┓", muted)
		rows[len(rows)-1] = accent("┗"+strings.Repeat("─", w-2)+"┛", muted)
		content = strings.Join(rows, "\n")
	}
	if m.setup.step == 0 {
		ink := muted
		if interference {
			ink = splashInks[1]
		}
		content = fit(accent("  "+title, ink)+"\n"+lipgloss.NewStyle().Width(w).Align(lipgloss.Center).Render(body), w, contentH)
	}
	progress := m.setup.step * 100 / 6
	barWidth := min(40, max(1, w-22))
	filled := barWidth * progress / 100
	bar := accent(strings.Repeat("█", filled), lime) + accent(strings.Repeat("░", barWidth-filled), muted)
	footer := bar + " " + strong(fmt.Sprintf("%3d%%", progress), cyan) + "\n" + keys
	if m.notice != "" {
		footer += "\n" + accent(wrap(uiText(m.notice), max(1, w-4)), amber)
	} else {
		footer += "\n" + accent(localText("[Ctrl+Q] Exit · setup resumes next time", "[Ctrl+Q] Salir · la configuración continúa al volver"), muted)
	}
	if m.quitting {
		footer = strong(localText("Exit Fluke? [y/n]", "¿Salir de Fluke? [s/n]"), amber)
	}
	return fit(content+"\n"+frame(localText("SETUP PROGRESS", "PROGRESO DE CONFIGURACIÓN"), footer, w, 7, cyan, false), w, h)
}

// Single-cell corruption keeps terminal alignment; choices and inputs stay intact.
func setupSignalText(text string, frame int) string {
	if frame%64 != 40 && frame%64 != 41 {
		return text
	}
	runes := []rune(text)
	for i, r := range runes {
		if r >= 'A' && r <= 'Z' {
			runes[i] = '░'
			break
		}
	}
	return string(runes)
}
