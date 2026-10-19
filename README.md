# filetree-local

Um mod local do Claude Code que mostra uma árvore de arquivos no estilo de IDE num painel lateral: navegação por teclado e mouse, status do git, o que o Claude lê e escreve brilhando na árvore, busca, colunas de data, idade ou tamanho, preview de arquivos e menções `@` no prompt.

É uma reescrita independente do mod [`claude-code-filetree`](https://github.com/data-goblin/claude-code-filetree) (v0.2.26), feita para rodar só código que o autor entende e controla: sem shell, sem marketplace, sem atualização automática e sem nada escondido no prompt. O comportamento do original foi a especificação; o código não foi copiado.

- **Versão:** 0.9.0 (as nove fatias do roadmap).
- **Plataforma:** Windows. A camada de SO (`hooks/os.ts`) deixa o resto pronto para outras plataformas, mas só o Windows é verificado.
- **Requisitos:** Claude Code 2.1.302 ou mais novo, no layout fullscreen (`/tui fullscreen`), com o terminal de pelo menos 110 colunas. O app desktop encaixa o painel sozinho.

## Instalação

O mod carrega direto desta pasta, sem cópia instalada. Acrescente em `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\w4rl0ck\\Documents\\Devs\\claude-filetree"
  }
}
```

Numa sessão nova, `/plugin` deve listar `filetree-local`. O painel abre ao iniciar a sessão (opção `start`) e `/filetree` o reabre.

## Uso

### Comando

| Comando | Efeito |
|---|---|
| `/filetree` | abre o painel na cwd e passa a segui-la |
| `/filetree <caminho>` | enraíza a árvore numa pasta (aceita `~`, relativo, aspas); deixa de seguir a cwd |

### Teclado (com o painel focado)

| Tecla | Árvore | Preview |
|---|---|---|
| `j` / `↓`, `k` / `↑` | cursor uma linha | rola uma linha |
| `PageDown` / `PageUp` | cursor 10 linhas | rola uma página (`f` / `b` também) |
| `Home` / `End` | primeira / última linha | início / fim |
| `l` / `→` | abre a pasta | — |
| `h` / `←` | fecha a pasta ou vai à pasta-mãe | volta à árvore |
| `Enter` | pasta: abre/fecha. Arquivo: abre (opção `open`) | — |
| `Space` | pasta: abre/fecha. Arquivo: seleciona | — |
| `y` / `Y` | copia o caminho relativo / absoluto | — |
| `s` | foca a busca | — |
| `a` | põe `@caminho` da linha do cursor na caixa do prompt | — |
| `e` | — | abre no editor (opção `edit`) na linha do topo |

### Mouse

| Gesto | Efeito |
|---|---|
| clique | seleciona o arquivo, ou abre/fecha a pasta |
| duplo clique, ou clique com `Ctrl`/`Shift` | arquivo: abre (opção `open`). Pasta: enraíza a árvore nela |
| clique direito / `Shift` + clique direito | copia o caminho relativo / absoluto |
| roda, arraste da barra | rola a árvore ou o preview |
| passar sobre um botão do cabeçalho | mostra o que ele faz |

### Cabeçalho, busca e rodapé

- **Botões:** `↑` pasta-mãe, `⌂` seguir a cwd, `↻` reler árvore e git, `◉`/`○` mostrar/ocultar ocultos, `Σ` alternar tamanhos, `⊟` recolher tudo, `⊘` limpar a seleção.
- **Linha da branch:** branch, upstream, ahead/behind e o total `+N -N` da raiz. Fora de um repositório, uma dica (opção `hints`).
- **Busca:** filtra a árvore enquanto você digita, inclusive em pastas ainda fechadas (`git ls-files`, ou varredura por `fs.list` fora de um repositório). `Enter` pula para o primeiro resultado; `×` limpa.
- **Rodapé:** `@` (menciona o selecionado no prompt), `selected: <caminho>` e o chip da última ação de git (`committed <sha>`, `pushed`, `staged N`…).

### O que a árvore mostra

- **Status do git:** cores por letra (`?`, `A`, `M`, `D`, `R`…), `+N -N` por arquivo, contagens por pasta, ignorados em cinza.
- **Atividade do Claude:** arquivos lidos (`Read`, `Grep`, `Glob`) brilham em roxo, escritos (`Edit`, `Write`, `NotebookEdit` ou um comando de shell) em laranja, commitados ou preparados em verde; pastas fechadas abrem para mostrar o arquivo.
- **Coluna da direita:** data, idade (`now`, `12m`, `3h`, `5d`) ou tamanho, com as pastas somadas em segundo plano.
- **Atualização automática:** releitura periódica enquanto o painel aparece, e git status dentro de um segundo depois de commits e stages, inclusive de outra sessão.

### Abrir, preview e edição

- **App padrão** (`open: app`): duplo clique ou `Enter` abrem o arquivo no programa associado do Windows, por `%WINDIR%\explorer.exe <caminho>`. Programas e scripts (`.exe`, `.bat`, `.ps1`, `.lnk`, `.url`, `.js`, `.msi`…) **nunca** são executados, nem por um link que leve a eles; caminhos com vírgula e de rede também são recusados, com um aviso.
- **Preview** (`open: preview`): o arquivo aparece no painel, Markdown desenhado e código com cores e números de linha. Só lê arquivos cujo caminho real (links resolvidos) fica dentro do caminho real da cwd; os outros mostram uma nota, e `↗` os abre no app padrão. Arquivos acima de 4 MiB, binários e ilegíveis também mostram uma nota.
- **Editor** (`edit`): `e` no preview abre o arquivo na linha do topo por um link `vscode://`, `vscode-insiders://` ou `cursor://`, entregue pelo `explorer.exe`.

### Seleção no prompt

Nada vai para o modelo sem você ver:

- `a` (ou o botão `@` do rodapé) põe `@caminho ` na caixa do prompt, onde você edita ou apaga antes de enviar. Caminhos com espaço vão entre aspas: `@"my file.ts"`.
- Com `selection: append`, cada prompt digitado com um arquivo selecionado ganha no fim do próprio texto a linha `(selected in the file tree: <caminho>)`, que aparece na sua mensagem na transcrição.
- Toda `@menção` que você digitar e que o Claude Code anexar abre as pastas até o arquivo e põe o cursor nele.

## Opções

Em `/plugin` → `filetree-local` → configurar.

| Opção | Valores (padrão primeiro) | O que faz |
|---|---|---|
| `start` | `on`, `off` | abre o painel ao iniciar a sessão |
| `activity` | `reads and writes`, `writes`, `reads`, `none` | qual atividade do Claude brilha |
| `follow` | `on`, `off` | a árvore rola até o que o Claude toca |
| `refresh` | `5s`, `off`, `2s`, `10s` | período da releitura automática |
| `hints` | `on`, `off` | dica de `git init` fora de um repositório |
| `column` | `date`, `age`, `size` | o que a coluna da direita mostra; `Σ` alterna |
| `glyphs` | `auto`, `nerd`, `plain` | ícones Nerd Font (`auto`: quando instalada, no terminal) |
| `open` | `app`, `preview`, `select` | o que duplo clique e `Enter` fazem com um arquivo |
| `edit` | `off`, `vscode`, `vscode-insiders`, `cursor` | o editor do `e` no preview |
| `selection` | `mention`, `append`, `off` | como a seleção chega ao prompt, sempre à vista |

## Regras de segurança

Estas regras (spec-00 R1) diferenciam o mod do original e são conferidas na saída de `claude plugin validate` e nos testes:

| Regra | Como é garantida |
|---|---|
| Nenhum shell (`sh`, `bash`, `cmd`, `powershell`, `pwsh`) | os únicos `argv[0]` são `git.exe` e `%WINDIR%\explorer.exe` por caminho absoluto |
| Só executáveis da lista | `git.exe` (só subcomandos de leitura, com `--no-optional-locks -c core.fsmonitor=false`) e `explorer.exe` com um único argumento |
| `tool.call` só observa | o hook repassa o mesmo `e` e devolve o mesmo resultado |
| Nada invisível no prompt | `e.context` nunca é usado; a única mudança de texto é a linha opcional de `selection: append`, que aparece na mensagem |
| Leitura só dentro do projeto | `$.fs.read` só em `loadPreview`, e só do caminho real dentro do caminho real da cwd |
| Sem escrita em disco, rede, modelos ou ferramentas | nenhuma chamada a `fs.write`, `store`, `http`, `model`, `agent` ou `tool.register` |
| Variáveis de ambiente da lista | `OS`, `USERPROFILE`, `HOME`, `WINDIR`, `LOCALAPPDATA` |
| Sem atualização automática | carregado de uma pasta local versionada, sem marketplace |

## Arquitetura

Um único módulo de entrada registra os hooks e delega a módulos puros, testáveis sem o engine.

| Módulo | Responsabilidade |
|---|---|
| `hooks/register.tsx` | hooks, `$.state`, chamadas a `$.fs`, `$.process`, `$.ui` e `$.prompt`; orquestração |
| `hooks/os.ts` | `Paths` (caminhos normalizados, comparação sem diferenciar maiúsculas no Windows), executáveis e variáveis permitidas |
| `hooks/tree.ts` | modelo da árvore: nós, ordenação, linhas visíveis, navegação |
| `hooks/activity.ts` | o que cada tool call tocou e o brilho |
| `hooks/git.ts` | argumentos do git, parse de status e numstat, chips |
| `hooks/search.ts` | índice e filtro da busca |
| `hooks/columns.ts` | modos e formatos da coluna da direita |
| `hooks/icons.ts` | glyphs, rótulos e largura em pontos de código |
| `hooks/open.ts` | opções de abrir/editar, recusas, link do editor, preparação e janela do preview |
| `hooks/selection.ts` | referência, menção e linha acrescentada da seleção |
| `hooks/pane.tsx` | estado → árvore de elementos (painel e preview) |
| `hooks/rows.tsx`, `hooks/button.tsx` | Clients: linhas, preview, botões com hover |
| `types/index.d.ts` | contrato de `$.state` (`tree`, `memory`, `activity`, `git`, `chip`, `search`, `columns`, `preview`) |

## Desenvolvimento

```powershell
claude plugin validate .   # manifesto, hooks, chamadas, env e estado
tsc -p .                   # tipos (npm install -g typescript; só ferramenta de desenvolvimento)
claude plugin test .       # 282 testes, nas superfícies terminal e desktop
```

O repositório não tem dependências de runtime nem `package.json`. Os testes ficam em `tests/`; `tests/world.ts` e o início de `tests/pane.test.tsx` simulam uma máquina Windows por baixo do plugin (pastas, textos, links, git, `explorer.exe`, caixa do prompt).

## Especificações

Cada fatia tem a sua spec em `.workbench/work-items/20261016-filetree-local/`:

| Spec | Fatia |
|---|---|
| `spec-00-overview.md` | visão geral, regras globais (R1–R4), camada de SO, roadmap |
| `spec-01-pane-tree-navigation.md` | painel, árvore e navegação |
| `spec-02-claude-activity.md` | atividade do Claude |
| `spec-03-git-status.md` | status do git |
| `spec-04-git-activity.md` | atividade de git (chips, verde, linha da branch) |
| `spec-05-auto-refresh.md` | atualização automática |
| `spec-06-search.md` | busca |
| `spec-07-columns-and-look.md` | colunas, glyphs e hover |
| `spec-08-open-preview-edit.md` | abrir com o app padrão, preview e edição |
| `spec-09-selection-context.md` | seleção no prompt e `@menções` |

## Diferenças do original

| Original | Aqui | Por quê |
|---|---|---|
| abre arquivos com `powershell -Command` | `%WINDIR%\explorer.exe <caminho>` | sem shell |
| "Open with" aceita qualquer comando | `edit` com uma lista fechada de editores por link | sem execução arbitrária |
| duplo clique abre qualquer arquivo | programas e scripts recusados | um clique não executa código do projeto |
| preview lê qualquer arquivo da árvore | só dentro da cwd, pelo caminho real | a árvore pode estar em `C:\` |
| seleção vai em `e.context`, invisível | menção na caixa do prompt ou linha visível | nada escondido do usuário |
| `@menções` por expressão regular | pelo `prompt.mention` do engine | usa o que o engine resolveu e anexou |
| caminhos comparados diferenciando maiúsculas | sem diferenciar no Windows | `C:\Devs` e `c:\devs` são a mesma pasta |
| detecção de Nerd Font por `sh -c` | listagem das pastas de fontes do Windows | sem shell, e funciona no Windows |
| marketplace com atualização automática | pasta local | nenhum canal de atualização de terceiros |

Não portados: Quick Look (macOS), editor via tmux/herdr, tema Omarchy, editores de terminal (`$VISUAL`/`$EDITOR`).

## Verificação manual pendente

Os testes cobrem os critérios de aceitação; estes pontos dependem do Windows real e ficam para a revisão do autor:

1. Duplo clique num `.md` e num `.png` abre os apps padrão; num `.bat`, só o aviso (spec-08 A1).
2. Com `edit: vscode`, `e` no preview abre o VS Code na linha mostrada (spec-08 A2).
3. O foco vai a `back`/`edit` ao abrir o preview e volta a `open` ao fechar (spec-08 R6.4).
4. `a` põe `@caminho ` na caixa do prompt, e `@"caminho com espaço"` é entendido como menção (spec-09 A1).
5. Com `selection: append`, a linha aparece no fim da mensagem na transcrição (spec-09 A2).
6. Ícones Nerd Font alinhados e realce de linha legível (spec-07 A1, A2).