// Utilitarios gerais do SyncLab.
// Sem dependencias externas: roda no navegador (ES module) e no Node.
// O proprio codigo-fonte e mantido em ASCII puro, pelo mesmo motivo que a
// saida gerada tambem e: colar em qualquer editor nunca corrompe nada.
// Por isso os intervalos Unicode aparecem via RegExp(...) com escapes duplos,
// e nunca como caractere literal.

function re(padrao, flags) {
  return new RegExp(padrao, flags);
}

// Zero-width, BOM, marcas de direcao, espacos exoticos e controles C0/C1.
var INVISIBLE_RE = re(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
  '\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E' +
  '\\u200B-\\u200F\\u2028-\\u202F\\u205F-\\u206F\\u3164\\uFEFF\\uFFA0]',
  'g'
);

// Marcas combinantes deixadas para tras pela normalizacao NFD.
var COMBINANTES_RE = re('[\\u0300-\\u036F]', 'g');

// Qualquer coisa fora do ASCII imprimivel, preservando tab / LF / CR.
//
// Preservar a quebra de linha nao e detalhe cosmetico: escaparParaJs roda
// sobre codigo JavaScript inteiro, e uma quebra de linha convertida em
// escape fora de um literal de string quebra a sintaxe do arquivo gerado.
var NAO_ASCII_RE = re('[^\\x09\\x0A\\x0D\\x20-\\x7E]', 'g');

// Mesma classe, sem a flag global, para teste e busca pontual.
var NAO_ASCII_TEXTO_RE = re('[^\\x09\\x0A\\x0D\\x20-\\x7E]');

/**
 * Remove caracteres invisiveis (zero-width, BOM, marcas de direcao, controles).
 * Usado nos campos de chave de API e credenciais, onde um colar descuidado
 * traz lixo que o servidor rejeita com uma mensagem incompreensivel.
 */
export function limparInvisiveis(texto) {
  if (typeof texto !== 'string') return '';
  return texto.replace(INVISIBLE_RE, '').trim();
}

/** Troca qualquer sequencia de espacos/quebras por um unico espaco. */
export function normalizarEspacos(texto) {
  return String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
}

// Letras que a normalizacao NFD nao decompoe: precisam de mapa explicito.
// Escrito por code point para manter o fonte em ASCII.
var MAPA_ACENTOS = (function () {
  var pares = [
    [0x00E7, 'c'], [0x00C7, 'C'],   // c-cedilha
    [0x00F1, 'n'], [0x00D1, 'N'],   // n-til
    [0x00DF, 'ss'],                 // eszett
    [0x00E6, 'ae'], [0x00C6, 'AE'],
    [0x0153, 'oe'], [0x0152, 'OE'],
    [0x00F8, 'o'], [0x00D8, 'O'],
    [0x0111, 'd'], [0x0110, 'D'],
    [0x00F0, 'd'], [0x00FE, 'th']
  ];
  var mapa = Object.create(null);
  for (var i = 0; i < pares.length; i++) {
    mapa[String.fromCharCode(pares[i][0])] = pares[i][1];
  }
  return mapa;
})();

/** Remove acentuacao mantendo a letra base ("cardiologia" continua legivel). */
export function removerAcentos(texto) {
  var base = String(texto == null ? '' : texto);
  if (typeof base.normalize === 'function') {
    base = base.normalize('NFD').replace(COMBINANTES_RE, '');
  }
  return base.replace(NAO_ASCII_RE, function (ch) {
    return MAPA_ACENTOS[ch] || '';
  });
}

/**
 * Sanitiza o nome-base usado em HTML, audio, legendas, zip e chaves do S3.
 * Sem acentos, sem espacos, tudo minusculo, so [a-z0-9-.].
 */
export function sanitizarNomeArquivo(nome, alternativa) {
  var limpo = removerAcentos(limparInvisiveis(nome))
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-.]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-\.|\.-/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  return limpo || (alternativa || 'synclab');
}

function hex4(codigo) {
  return codigo.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Converte qualquer caractere fora do ASCII imprimivel em escape \uXXXX.
 * Aplicado a strings que vao para dentro de codigo JavaScript gerado.
 */
export function escaparParaJs(texto) {
  return String(texto == null ? '' : texto).replace(NAO_ASCII_RE, function (ch) {
    return '\\u' + hex4(ch.charCodeAt(0));
  });
}

/**
 * JSON pronto para embutir em <script>: ASCII puro e sem sequencias que
 * fechariam a tag ou abririam um comentario HTML.
 */
export function jsonAscii(valor) {
  return escaparParaJs(JSON.stringify(valor))
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026');
}

/** Texto para dentro de HTML: escapa metacaracteres e sai em ASCII puro. */
export function htmlAscii(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(NAO_ASCII_RE, function (ch) {
      return '&#' + ch.charCodeAt(0) + ';';
    });
}

/** Valor de atributo HTML em ASCII puro. */
export function atributoAscii(texto) {
  return htmlAscii(texto);
}

/** Escapa acentos para CSS (\XXXX seguido de espaco), usado em nomes de fonte. */
export function cssAscii(texto) {
  return String(texto == null ? '' : texto).replace(NAO_ASCII_RE, function (ch) {
    return '\\' + hex4(ch.charCodeAt(0)) + ' ';
  });
}

/** Verifica se a saida gerada ficou de fato em ASCII puro. */
export function ehAsciiPuro(texto) {
  return !NAO_ASCII_TEXTO_RE.test(String(texto == null ? '' : texto));
}

/** Aponta o primeiro caractere nao-ASCII, para mensagem de erro util. */
export function primeiroNaoAscii(texto) {
  var s = String(texto == null ? '' : texto);
  var m = NAO_ASCII_TEXTO_RE.exec(s);
  if (!m) return null;
  return {
    indice: m.index,
    caractere: m[0],
    codigo: 'U+' + hex4(m[0].charCodeAt(0)),
    trecho: s.slice(Math.max(0, m.index - 30), m.index + 30)
  };
}

/** Segundos -> "HH:MM:SS,mmm" (SRT). */
export function tempoSrt(segundos) {
  return formatarTempo(segundos, ',');
}

/** Segundos -> "HH:MM:SS.mmm" (VTT). */
export function tempoVtt(segundos) {
  return formatarTempo(segundos, '.');
}

function formatarTempo(segundos, separador) {
  var total = Math.max(0, Number(segundos) || 0);
  var ms = Math.round(total * 1000);
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  var s = Math.floor((ms % 60000) / 1000);
  var resto = ms % 1000;
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + separador + pad(resto, 3);
}

function pad(n, casas) {
  return String(n).padStart(casas, '0');
}

/** "HH:MM:SS,mmm" ou "MM:SS.mmm" -> segundos. */
export function tempoParaSegundos(texto) {
  var m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*$/.exec(String(texto));
  if (!m) return null;
  var h = Number(m[1] || 0);
  var min = Number(m[2]);
  var seg = Number(m[3]);
  var ms = Number(String(m[4]).padEnd(3, '0'));
  return h * 3600 + min * 60 + seg + ms / 1000;
}

/** Duracao amigavel para o painel de diagnostico. */
export function formatarDuracao(segundos) {
  var total = Math.max(0, Number(segundos) || 0);
  var m = Math.floor(total / 60);
  var s = total - m * 60;
  return m + 'm ' + s.toFixed(2).padStart(5, '0') + 's';
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Uint8Array -> base64 (funciona em navegador e Node, sem Buffer). */
export function bytesParaBase64(bytes) {
  var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var saida = '';
  for (var i = 0; i < arr.length; i += 3) {
    var b0 = arr[i];
    var b1 = arr[i + 1];
    var b2 = arr[i + 2];
    saida += B64[b0 >> 2];
    saida += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    saida += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    saida += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return saida;
}

/** base64 -> Uint8Array. */
export function base64ParaBytes(texto) {
  var limpo = String(texto || '').replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  var saida = new Uint8Array(Math.floor((limpo.length * 3) / 4));
  var pos = 0;
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < limpo.length; i++) {
    buffer = (buffer << 6) | B64.indexOf(limpo[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      saida[pos++] = (buffer >> bits) & 0xff;
    }
  }
  return saida.subarray(0, pos);
}

/** Bytes -> hexadecimal minusculo (assinatura AWS). */
export function bytesParaHex(bytes) {
  var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var saida = '';
  for (var i = 0; i < arr.length; i++) saida += arr[i].toString(16).padStart(2, '0');
  return saida;
}

/** Texto UTF-8 -> bytes. */
export function textoParaBytes(texto) {
  return new TextEncoder().encode(String(texto == null ? '' : texto));
}

/** Identificador curto para prefixar ids/classes do trecho gerado. */
export function idCurto(semente) {
  var base = String(semente || '') + '|' + Date.now() + '|' + Math.random();
  var h = 2166136261;
  for (var i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

/** Numero dentro de faixa, com valor padrao quando a entrada e invalida. */
export function numeroEmFaixa(valor, minimo, maximo, padrao) {
  var n = Number(valor);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(maximo, Math.max(minimo, n));
}
