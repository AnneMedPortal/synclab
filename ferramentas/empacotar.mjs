// Empacota o SyncLab num unico arquivo HTML, sem nenhuma dependencia externa.
//
// Serve para hospedar a ferramenta onde so cabe um arquivo, ou para levar num
// pendrive. O SyncLab normal (src/index.html) continua sendo a versao de
// trabalho: modulos separados, mais facil de ler e de mexer.
//
//   node ferramentas/empacotar.mjs [destino.html] [--aviso-hospedagem]
//
// --aviso-hospedagem acrescenta um recado sobre ambientes que bloqueiam
// chamadas de rede, onde as secoes de ElevenLabs e S3 nao funcionam.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(RAIZ, 'src', 'js');

// Ordem de dependencia: cada modulo so importa de quem vem antes dele.
const MODULOS = ['util', 'runtime', 'legendas', 'aparencia', 'elevenlabs', 'zip', 's3', 'gerador'];
const ENTRADA = 'app';

const RE_IMPORT = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/([\w.-]+)\.js['"];?[ \t]*\n/gm;
const RE_EXPORT = /^export\s+(?=(?:async\s+)?function|class|var|const|let)/gm;
const RE_NOME_EXPORTADO = /^export\s+(?:async\s+)?(?:function|class|var|const|let)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Converte um modulo ES em uma IIFE que devolve seus exports.
 * Isolar cada modulo em seu proprio escopo evita que um nome interno de um
 * colida com o de outro -- concatenar tudo num escopo so seria mais curto e
 * bem mais fragil.
 */
function converter(nome) {
  const fonte = fs.readFileSync(path.join(JS, nome + '.js'), 'utf8');

  const exportados = [];
  let m;
  RE_NOME_EXPORTADO.lastIndex = 0;
  while ((m = RE_NOME_EXPORTADO.exec(fonte)) !== null) exportados.push(m[1]);

  let corpo = fonte
    .replace(RE_IMPORT, (_, nomes, alvo) => {
      const lista = nomes.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
      return `  const { ${lista} } = MOD.${alvo};\n`;
    })
    .replace(RE_EXPORT, '');

  corpo = corpo.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');

  if (nome === ENTRADA) {
    return `// ---- ${nome}.js ----\n(function () {\n${corpo}\n})();\n`;
  }
  return `// ---- ${nome}.js ----\nMOD.${nome} = (function () {\n${corpo}\n  return { ${exportados.join(', ')} };\n})();\n`;
}

const AVISO = `
<section class="cartao" id="sec-aviso-hospedagem">
  <h2><span class="indice">!</span>Sobre esta versão hospedada</h2>
  <p class="ajuda">
    Esta página é o SyncLab inteiro num arquivo só. O ambiente que a hospeda
    bloqueia chamadas de rede para fora, então <strong>as seções 1 (ElevenLabs)
    e 9 (S3) não conseguem se conectar aqui</strong> — o botão responde, mas a
    chamada não sai. Nada disso é defeito da ferramenta: é a política de
    segurança da hospedagem.
  </p>
  <p class="ajuda">
    Funciona por completo nesta página: importar áudio e SRT/VTT prontos
    (seção 3), as regras de segmentação, a aparência, a pré-visualização e toda
    a seção 8 — gerar o trecho inline, copiar e baixar HTML, SRT, VTT e o
    pacote .zip. Ou seja, dá para percorrer o caminho inteiro sem gastar
    créditos, desde que o áudio venha de um arquivo.
  </p>
  <p class="ajuda">
    Para o fluxo completo, rode o SyncLab na sua máquina:
    <code>cd src &amp;&amp; python3 -m http.server 8000</code>, e abra
    <code>http://localhost:8000</code>.
  </p>
</section>
`;

function empacotar({ avisoHospedagem }) {
  const html = fs.readFileSync(path.join(RAIZ, 'src', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(RAIZ, 'src', 'css', 'app.css'), 'utf8');

  const pacote =
    '(function () {\n' +
    '  "use strict";\n' +
    '  const MOD = {};\n' +
    MODULOS.map(converter).join('\n') +
    '\n' + converter(ENTRADA) +
    '})();\n';

  // As substituicoes usam funcao, e nao string, de proposito. Numa string de
  // substituicao o cifrao e especial: $' significa "tudo o que vem depois do
  // match". O codigo embutido tem um $' (o fim do regex de fim de frase em
  // legendas.js), e a forma com string expandia isso, despejando o resto do
  // index.html -- inclusive um </body> -- no meio do JavaScript.
  let saida = html
    .replace('<link rel="stylesheet" href="css/app.css">', () => '<style>\n' + css + '</style>')
    .replace(
      '<script type="module" src="js/app.js"></script>',
      () => '<script>\n' + pacote + '</script>'
    );

  if (avisoHospedagem) saida = saida.replace('<main>\n', '<main>\n' + AVISO);

  return saida;
}

/**
 * Variante para hospedagens que ja fornecem o esqueleto do documento e pedem
 * so o conteudo (o publicador de Artifacts e uma delas). Tira doctype, html,
 * head e body, mantendo titulo, estilo, marcacao e script.
 */
function soConteudo(html) {
  const titulo = /<title>[\s\S]*?<\/title>/.exec(html);
  const estilo = /<style>[\s\S]*?<\/style>/.exec(html);
  const corpo = /<body>\n([\s\S]*?)\n<\/body>/.exec(html);

  if (!titulo || !estilo || !corpo) {
    throw new Error('index.html mudou de forma; ajuste soConteudo() antes de publicar.');
  }
  return titulo[0] + '\n' + estilo[0] + '\n' + corpo[1] + '\n';
}

const args = process.argv.slice(2);
const destino = args.find((a) => !a.startsWith('--')) || path.join(RAIZ, 'synclab.html');
let saida = empacotar({ avisoHospedagem: args.includes('--aviso-hospedagem') });
if (args.includes('--so-conteudo')) saida = soConteudo(saida);

fs.writeFileSync(destino, saida);
console.log('gerado: ' + destino + ' (' + (Buffer.byteLength(saida) / 1024).toFixed(1) + ' KB)');
