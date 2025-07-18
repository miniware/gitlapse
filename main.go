package main

// A simple program that opens the alternate screen buffer and displays mouse
// coordinates and events.

import (
	"log"
	"os/exec"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type model struct {
	mouseEvent tea.MouseEvent
	commits    []string
}

type commits []string

type step string

func (m model) Init() tea.Cmd {
	return getCommits
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if s := msg.String(); s == "ctrl+c" || s == "q" || s == "esc" {
			return m, tea.Quit

		}
	case commits:
		m.commits = msg
	}

	return m, nil
}

func getCommits() tea.Msg {
	logs, err := exec.Command("git", strings.Split("log --oneline --no-decorate", " ")...).Output()
	if err != nil {
		panic(err)
	}
	return commits(strings.Split(string(logs), "\n"))
}

func (m model) View() string {
	s := "(Press q to quit.)\n\n"

	s += "Commits found:" + strconv.Itoa(len(m.commits))

	return s
}

func main() {
	p := tea.NewProgram(model{})
	if _, err := p.Run(); err != nil {
		log.Fatal(err)
	}
}
