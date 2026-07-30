// Gerador da saida final.
//
// Produz duas formas do mesmo conteudo:
//   - trecho inline, para colar direto num elemento HTML do Genially. Sem
//     iframe: e justamente o iframe que quebra o autoplay, porque o gesto do
//     usuario registrado na pagina de fora nao alcanca o documento de dentro.
//   - documento completo, para hospedar como arquivo e usar via iframe/URL
//     quando o fluxo exigir.
//
// Toda a saida sai em ASCII puro, e isso e conferido antes de devolver: um
// acento cru sobrevivendo ate aqui vira caractere quebrado quando o texto passa
// por um editor que assume outra codificacao.

import {
  jsonAscii, htmlAscii, escaparParaJs, ehAsciiPuro, primeiroNaoAscii,
  bytesParaBase64, idCurto, sanitizarNomeArquivo
} from './util.js';
import { cssDaLegenda, cssDoDiagnostico, combinarAparencia } from './aparencia.js';
import { paraFormatoCompacto } from './legendas.js';
import { FONTE_RUNTIME } from './runtime.js';

export var INTERVALO_TENTATIVA_PADRAO = 400;

/** Erro de geracao, com mensagem em portugues. */
export class ErroGeracao extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroGeracao';
  }
}

/**
 * @typedef {object} DadosDeSaida
 * @property {string} nomeBase
 * @property {Array} cues blocos de legenda ja segmentados
 * @property {object} aparencia
 * @property {{modo: 'embutido'|'url', bytes?: Uint8Array, url?: string, tipo?: string}} audio
 * @property {boolean} diagnostico
 * @property {string} [prefixo]
 * @property {number} [intervaloTentativa]
 */

function resolverPrefixo(dados) {
  if (dados.prefixo) return String(dados.prefixo).replace(/[^A-Za-z0-9-]/g, '');
  return 'synclab-' + idCurto(dados.nomeBase || 'synclab');
}

/** Monta a URL do audio conforme o modo escolhido. */
export function resolverFonteDeAudio(audio) {
  var cfg = audio || {};
  if (cfg.modo === 'url') {
    var url = String(cfg.url || '').trim();
    if (!url) {
      throw new ErroGeracao(
        'Voce escolheu audio por URL externa, mas nao informou a URL. ' +
        'Publique o MP3 no S3 primeiro ou mude para audio embutido.'
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new ErroGeracao(
        'A URL do audio precisa comecar com http:// ou https://. ' +
        'Valor informado: ' + url
      );
    }
    if (/^http:\/\//i.test(url)) {
      // Nao impede, mas o navegador vai impedir depois; melhor avisar aqui.
      cfg.aviso = 'A URL do audio usa http. Dentro do Genially, que roda em https, ' +
        'o navegador bloqueia conteudo misto e o audio nao carrega. Use https.';
    }
    return { src: url, embutido: false, tamanho: 0, aviso: cfg.aviso || '' };
  }

  var bytes = cfg.bytes;
  if (!bytes || !bytes.length) {
    throw new ErroGeracao(
      'Nao ha audio para embutir. Gere ou importe o audio antes de exportar.'
    );
  }
  var tipo = cfg.tipo || 'audio/mpeg';
  return {
    src: 'data:' + tipo + ';base64,' + bytesParaBase64(bytes),
    embutido: true,
    tamanho: bytes.length,
    aviso: ''
  };
}

/** Corpo comum ao trecho inline e ao documento completo. */
function montarPartes(dados) {
  if (!dados || !dados.cues || !dados.cues.length) {
    throw new ErroGeracao(
      'Nao ha blocos de legenda para exportar. Gere o audio com timestamps, ' +
      'importe um SRT/VTT ou transcreva o audio pelo Scribe.'
    );
  }

  var prefixo = resolverPrefixo(dados);
  var aparencia = combinarAparencia(dados.aparencia);
  var fonte = resolverFonteDeAudio(dados.audio);

  var configuracao = {
    id: prefixo,
    prefixo: prefixo,
    cues: paraFormatoCompacto(dados.cues),
    audio: fonte.src,
    audioEmbutido: fonte.embutido,
    tamanhoAudio: fonte.tamanho,
    diagnostico: !!dados.diagnostico,
    intervaloTentativa: Number(dados.intervaloTentativa) || INTERVALO_TENTATIVA_PADRAO,
    volume: dados.volume == null ? null : Number(dados.volume)
  };

  var css = cssDaLegenda(prefixo, aparencia) +
    (dados.diagnostico ? cssDoDiagnostico(prefixo) : '');

  // A fonte do runtime pode ter acentos dentro de literais de string; o escape
  // para \uXXXX e valido nesse contexto e deixa o resultado em ASCII.
  var script = escaparParaJs(FONTE_RUNTIME).replace(
    '__SYNCLAB_CONFIG__',
    function () { return jsonAscii(configuracao); }
  );

  var marcacao = [
    '<div id="' + prefixo + '" class="' + prefixo + '-raiz" data-synclab="raiz">',
    '  <div class="' + prefixo + '-caixa" data-synclab="caixa" data-visivel="0"></div>',
    '  <audio class="' + prefixo + '-audio" data-synclab="audio" preload="auto" playsinline webkit-playsinline></audio>',
    '</div>'
  ].join('\n');

  return {
    prefixo: prefixo,
    css: css,
    script: script,
    marcacao: marcacao,
    aviso: fonte.aviso,
    embutido: fonte.embutido,
    tamanhoAudio: fonte.tamanho
  };
}

function cabecalho(dados) {
  var nome = sanitizarNomeArquivo(dados.nomeBase || 'synclab');
  return '<!-- SyncLab | ' + htmlAscii(nome) + ' | ' + dados.cues.length +
    ' blocos de legenda | gerado automaticamente -->';
}

/**
 * Trecho inline: e o formato que resolve o autoplay, porque roda no mesmo
 * documento do slide e enxerga os gestos do aluno.
 */
export function gerarTrechoInline(dados) {
  var p = montarPartes(dados);
  var saida = [
    cabecalho(dados),
    '<style>',
    p.css.replace(/\n$/, ''),
    '</style>',
    p.marcacao,
    '<script>',
    p.script,
    '<\/script>'
  ].join('\n') + '\n';

  garantirAscii(saida, 'trecho inline');
  return { conteudo: saida, prefixo: p.prefixo, aviso: p.aviso, embutido: p.embutido };
}

/** Documento completo, para hospedar como arquivo ou usar em iframe. */
export function gerarDocumentoCompleto(dados) {
  var p = montarPartes(dados);
  var titulo = htmlAscii(dados.nomeBase || 'SyncLab');

  var saida = [
    '<!DOCTYPE html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>' + titulo + '</title>',
    cabecalho(dados),
    '<style>',
    // Fundo transparente tambem no documento: usado em iframe com allowtransparency,
    // o slide continua aparecendo por tras da legenda.
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden;}',
    'body{-webkit-font-smoothing:antialiased;}',
    p.css.replace(/\n$/, ''),
    '</style>',
    '</head>',
    '<body>',
    p.marcacao,
    '<script>',
    p.script,
    '<\/script>',
    '</body>',
    '</html>'
  ].join('\n') + '\n';

  garantirAscii(saida, 'documento completo');
  return { conteudo: saida, prefixo: p.prefixo, aviso: p.aviso, embutido: p.embutido };
}

/**
 * Confere que a saida ficou em ASCII puro. Falhar aqui e melhor que descobrir
 * o problema quando a legenda ja estiver com caractere quebrado na aula.
 */
export function garantirAscii(texto, ondeString) {
  if (ehAsciiPuro(texto)) return true;
  var achado = primeiroNaoAscii(texto);
  throw new ErroGeracao(
    'Falha interna: o ' + ondeString + ' saiu com um caractere fora do ASCII (' +
    achado.codigo + ') na posicao ' + achado.indice + '. Trecho: "' + achado.trecho + '". ' +
    'Isso e um defeito do gerador; por favor relate com o texto da narracao usado.'
  );
}

/** Estimativa do peso do trecho, para avisar antes de colar algo gigante. */
export function pesoLegivel(bytes) {
  var n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
