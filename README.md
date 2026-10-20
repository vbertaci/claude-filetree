# filetree-local

Um mod local do Claude Code que mostra uma árvore de arquivos no estilo de IDE num painel lateral: navegação por teclado e mouse, status do git, o que o Claude lê e escreve brilhando na árvore, busca, colunas de data, idade ou tamanho, preview de arquivos e menções `@` no prompt.

- **Versão:** 0.10.0 (as nove fatias do roadmap e a visão dos arquivos tocados pelo Claude).
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
| `t` | troca a árvore pela visão dos arquivos tocados pelo Claude, e de volta | — |
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

- **Botões:** `↑` pasta-mãe, `⌂` seguir a cwd, `↻` reler árvore e git, `◉`/`○` mostrar/ocultar ocultos, `Σ` alternar tamanhos, `⊟` recolher tudo, `✎` arquivos tocados pelo Claude, `⊘` limpar a seleção.
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

### Arquivos tocados pelo Claude

Num projeto com arquivos demais para a árvore, `✎` no cabeçalho (ou `t`) troca a árvore por uma visão só com o que o Claude mexeu nesta sessão:

- **changed** no topo: arquivos alterados por `Edit`, `Write`, `NotebookEdit` ou um comando de shell; **read** logo abaixo: arquivos lidos por `Read` ou `Grep` (`Glob` não conta). O mais recente primeiro; um arquivo lido e depois alterado fica só em changed.
- **Clique** num arquivo: seleciona (como na árvore) e o tira da lista. `Enter` ou `Ctrl`/`Shift` + clique também o abrem, conforme a opção `open`. Clique direito copia o caminho e o mantém na lista.
- **`clean`** esvazia as duas listas, só para limpar a visão: nada de commit, git ou arquivo.
- A visão não lista pastas nem roda git, então é leve em qualquer tamanho de projeto. Cada lista guarda até 200 arquivos, e as listas sobrevivem a um reload do mod.

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
| `hooks/touched.ts` | listas de arquivos alterados e lidos pelo Claude, e as teclas delas |
| `hooks/pane.tsx` | estado → árvore de elementos (painel, preview e visão dos arquivos tocados) |
| `hooks/rows.tsx`, `hooks/button.tsx` | Clients: linhas, preview, botões com hover |
| `types/index.d.ts` | contrato de `$.state` (`tree`, `memory`, `activity`, `git`, `chip`, `search`, `columns`, `preview`, `touched`) |

## Desenvolvimento

```powershell
claude plugin validate .   # manifesto, hooks, chamadas, env e estado
tsc -p .                   # tipos (npm install -g typescript; só ferramenta de desenvolvimento)
claude plugin test .       # 317 testes, nas superfícies terminal e desktop
```

O repositório não tem dependências de runtime nem `package.json`. Os testes ficam em `tests/`; `tests/world.ts` e o início de `tests/pane.test.tsx` simulam uma máquina Windows por baixo do plugin (pastas, textos, links, git, `explorer.exe`, caixa do prompt).
