package main

func agentLanguageInstruction(language string) string {
	if language == "es" {
		return "Idioma humano: español rioplatense. Escribí mensajes, preguntas, títulos y criterios para el humano en español. Conservá los campos y estados del protocolo. Si context.json declara otro idioma en language, seguí esa selección."
	}
	return "Human language: English. Write messages, questions, task titles and acceptance criteria for the human in English. Preserve protocol fields and status identifiers. If context.json declares a different language, follow that selection."
}
