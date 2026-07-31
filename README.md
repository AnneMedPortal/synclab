# SyncLab

Ferramenta para gerar narração com legenda sincronizada e colar direto num
slide do Genially — sem player, sem controles, com autoplay e fundo
transparente.

Roda inteiramente no navegador. Não há backend: as chaves vão do seu navegador
direto para a ElevenLabs e para a AWS, e não passam por nenhum servidor
intermediário.

## As três exigências que guiaram o projeto

1. **O aluno vê apenas a linha da legenda.** Sem player, sem botão, sem fundo,
   sem controle.
2. **O áudio toca sozinho.**
3. **A caixa é pequena, do tamanho do texto** — nunca uma faixa da largura toda.

Quase toda decisão técnica aqui existe por causa de uma dessas três. As três
são verificadas automaticamente num navegador de verdade
(`testes/navegador.mjs`).

## Onde abrir

**https://annemedportal.github.io/synclab/** — publicado a cada push no branch
padrão, pelo workflow em `.github/workflows/pages.yml`. Todas as nove seções
funcionam ali, inclusive a conexão com a ElevenLabs e o envio para o S3.

> **Antes do primeiro acesso, ligue o Pages uma vez.** O token do GitHub Actions
> publica no Pages, mas não tem permissão para criar o site — esse passo é
> manual, e só na primeira vez:
>
> 1. abra [Settings → Pages](https://github.com/AnneMedPortal/synclab/settings/pages);
> 2. em **Build and deployment**, no campo **Source**, escolha **GitHub Actions**.
>
> Depois, em **Actions → Publicar no GitHub Pages → Run workflow**, para publicar
> na hora sem esperar um novo push. Daí em diante é automático.

A página é pública, como qualquer site no GitHub Pages. Isso não expõe nada seu:
a chave de API e as credenciais da AWS são digitadas na hora, ficam apenas no
seu navegador e vão direto para a ElevenLabs e para a AWS. Não há segredo
algum no código.

Há também uma cópia em arquivo único em
`https://annemedportal.github.io/synclab/synclab-arquivo-unico.html`, para
baixar e usar offline.

## Como rodar na sua máquina

Precisa ser servido por HTTP — o navegador só libera a API de criptografia
(usada na assinatura do S3) e os módulos ES em `https://` ou `http://localhost`.
Abrir o `index.html` por duplo clique não funciona.

```bash
cd src
python3 -m http.server 8000
# abra http://localhost:8000
```

Ou publique o conteúdo de `src/` em qualquer hospedagem estática.

A interface acompanha o tema claro ou escuro do sistema, e o menu lateral vira
uma faixa de atalhos em telas estreitas. Nenhuma fonte ou folha de estilo é
baixada de fora: a ferramenta funciona offline depois de carregada.

### O caminho normal

1. **Conexão** — cole a chave da ElevenLabs e clique em *Conectar*. As vozes e
   os modelos da conta são carregados.
2. **Narração** — defina o nome-base dos arquivos **antes de gerar** e cole o
   texto.
3. **Legenda** — escolha uma das três origens (abaixo).
4. **Segmentação e aparência** — ajuste e veja o resultado na prévia.
5. **Saída** — gere e copie o trecho inline.
6. No Genially, insira um elemento de **HTML** e cole o trecho.

## As três origens de legenda

| Origem | Como funciona | Quando usar |
|---|---|---|
| **Texto → ElevenLabs** | Gera áudio e legenda na mesma chamada, pelo endpoint que devolve o timestamp de cada caractere falado. | O padrão. Sincronia perfeita, sem transcrição no meio. |
| **Áudio + SRT/VTT prontos** | Importa arquivos que você já tem. | Áudio gravado por uma pessoa, ou legenda revisada à mão. |
| **Só o áudio (Scribe)** | Transcreve automaticamente, com timestamp por palavra. | Áudio existente, sem legenda. |

As três desembocam na mesma estrutura interna — uma lista de palavras com
início e fim. É por isso que **reaplicar as regras de segmentação não regera o
áudio** (e não consome créditos): as regras rodam de novo sobre os tempos que
já existem.

## Dicionário de pronúncia

Para siglas e jargão médico que a voz lê errado. Dois tipos de regra:

- **substituição de grafia** — `IAM` → `infarto agudo do miocárdio`;
- **fonema em IPA** — força a pronúncia; só vale em alguns modelos.

O dicionário é salvo na sua conta da ElevenLabs e aplicado automaticamente nas
gerações seguintes.

> A chave de API precisa ter a **permissão de escrita de dicionário**
> habilitada. Sem ela a criação falha; o SyncLab detecta esse caso específico e
> diz exatamente o que habilitar no painel da ElevenLabs.

## Autoplay

O navegador bloqueia áudio com som antes de qualquer gesto do usuário. A
estratégia do SyncLab tem quatro partes:

- **Trecho inline, sem iframe.** É o que resolve o problema de fato: rodando no
  mesmo documento do slide, o script enxerga os gestos do aluno. Dentro de um
  iframe de outra origem, o gesto de fora não alcança o documento de dentro.
- **Tentativa contínua a cada 400 ms**, em vez de tentar uma vez e desistir.
- **Plano B mudo.** Se o som for bloqueado, o áudio toca mudo — o que nenhum
  navegador impede — para não perder a sincronia com o slide, e a tentativa de
  devolver o som continua em segundo plano. Ao desmutar, a posição atual é
  preservada: nada reinicia.
- **Escuta de interação também na página pai**, quando a origem permitir.

Sem loop: toca uma vez, do início ao fim.

## Painel de diagnóstico

Mostra na tela se o script rodou, quantas legendas carregaram, o endereço do
áudio, o estado do carregamento, a duração, o erro exato, se está tocando e se o
navegador bloqueou.

O campo mais útil é o **contexto**: informa se o conteúdo está na página
principal ou dentro de um iframe, e se a página pai é alcançável. É o que
revela quando o Genially embrulhou o conteúdo — a causa mais comum de "o áudio
não toca e ninguém sabe por quê".

**Desligue o painel na versão final do aluno** (a caixa fica desmarcada por
padrão).

## Hospedagem no S3

Upload direto do navegador, assinado com AWS SigV4 (a implementação é conferida
contra o vetor de teste publicado pela AWS, em `testes/executar.mjs`).

Os objetos vão com `Cache-Control: no-store`, para que republicar apareça
atualizado na hora — sem isso, o aluno continua ouvindo a versão antiga em cache
depois da correção.

O bucket precisa de uma regra de CORS parecida com esta:

```json
[{
  "AllowedOrigins": ["https://onde-voce-abre-o-synclab"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"]
}]
```

E uma credencial com permissão de `s3:PutObject` no prefixo usado. Os erros mais
comuns (assinatura recusada, região errada, acesso negado, relógio fora de hora)
são traduzidos para português com a instrução do que corrigir.

## Nomeação de arquivos

O nome-base é definido **antes de gerar** e vale para HTML, áudio, legendas, zip
e chaves do S3. A sanitização remove acentos, converte espaços em hífen e força
minúsculas:

```
"  Aula 03 — Coração & Pulmão  "  ->  aula-03-coracao-pulmao
```

O botão **Baixar HTML + MP3** baixa os dois sempre juntos, para nunca saírem
descasados.

## Robustez

- **Saída em ASCII puro.** Todo acento vira `\uXXXX` no JavaScript e `&#NNN;` no
  HTML, e a saída é conferida caractere a caractere antes de ser entregue — colar
  num editor que assuma outra codificação não corrompe nada. Todo módulo que
  participa da geração (`util`, `legendas`, `aparencia`, `runtime`, `gerador`,
  `s3`, `zip`) tem o próprio código-fonte em ASCII, pelo mesmo motivo; só
  `app.js`, que é texto de interface e nunca entra na saída, usa acentos.
- **Limpeza de caracteres invisíveis** nos campos de chave de API e credenciais.
  Zero-width, BOM e marcas de direção colados junto são removidos, com aviso.
- **Mensagens de erro em português**, dizendo o que fazer — não apenas o que
  falhou.

## Estrutura

```
src/
  index.html          interface de autoria
  css/app.css         estilo da ferramenta
  js/
    app.js            ligação entre a interface e os módulos
    elevenlabs.js     vozes, modelos, TTS, timestamps, Scribe, dicionário
    legendas.js       as três origens, regras de segmentação, SRT/VTT
    aparencia.js      CSS da legenda (usado na prévia E na exportação)
    runtime.js        o código que roda junto com o slide do aluno
    gerador.js        monta o trecho inline e o documento completo
    s3.js             assinatura SigV4 e upload
    zip.js            empacotador .zip
    util.js           nomes, escapes ASCII, tempos, base64
testes/
  executar.mjs        suite principal, sem dependências
  navegador.mjs       prova no navegador (Playwright, opcional)
```

`aparencia.js` é a única fonte do CSS da legenda: a prévia e o HTML exportado
chamam a mesma função, então o que se vê na tela é o que o aluno vê. Não existe
um CSS "de preview" e outro "de produção".

## Testes

```bash
npm test                  # 74 testes, sem nenhuma dependência
```

Cobre a lógica pura: sanitização de nomes, escapes ASCII, as três origens de
legenda, cada regra de segmentação, SRT/VTT ida e volta, aparência, geração da
saída, SigV4 e zip.

A prova no navegador é opcional e precisa do Playwright:

```bash
npm install --no-save playwright && npx playwright install chromium
npm run testar:navegador
```

Ela abre o HTML exportado num Chromium de verdade e confere as três exigências
inegociáveis, com autoplay liberado e com autoplay bloqueado.

> Nota: o Chromium headless bloqueia até o autoplay mudo, que num navegador real
> é sempre permitido. Por isso a prova com autoplay bloqueado verifica que o
> plano B foi acionado e que um gesto do aluno recupera o som — e não que o
> áudio mudo já esteja correndo.

## Segurança

A chave da ElevenLabs e as credenciais da AWS ficam apenas em memória, a menos
que você marque *Lembrar neste navegador* — aí vão para o `localStorage` em
texto legível. Só marque em um computador de uso pessoal.

Credenciais da AWS no navegador dão a quem tiver acesso à máquina o mesmo poder
que a política delas permite. Use uma credencial dedicada, restrita a
`s3:PutObject` no bucket e prefixo dessa finalidade.
