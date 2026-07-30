// Empacotador .zip minimo, sem compressao (metodo "store").
//
// O pacote leva MP3 (ja comprimido), HTML, SRT e VTT. Comprimir de novo daria
// ganho quase nulo e traria uma dependencia externa para dentro de uma
// ferramenta que roda inteira no navegador -- nao compensa.

import { textoParaBytes } from './util.js';

var TABELA_CRC = (function () {
  var tabela = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tabela[i] = c >>> 0;
  }
  return tabela;
})();

export function crc32(bytes) {
  var c = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) {
    c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dataDos(data) {
  var d = data || new Date();
  var hora = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  var dia = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { hora: hora & 0xffff, dia: dia & 0xffff };
}

/**
 * @param {Array<{nome: string, conteudo: Uint8Array|string}>} arquivos
 * @returns {Uint8Array} bytes do .zip
 */
export function montarZip(arquivos, data) {
  var carimbo = dataDos(data);
  var entradas = [];
  var tamanhoLocal = 0;
  var tamanhoCentral = 0;

  for (var i = 0; i < arquivos.length; i++) {
    var arquivo = arquivos[i];
    var conteudo = arquivo.conteudo instanceof Uint8Array
      ? arquivo.conteudo
      : textoParaBytes(arquivo.conteudo);
    var nome = textoParaBytes(arquivo.nome);
    var entrada = {
      nome: nome,
      conteudo: conteudo,
      crc: crc32(conteudo),
      deslocamento: tamanhoLocal
    };
    entradas.push(entrada);
    tamanhoLocal += 30 + nome.length + conteudo.length;
    tamanhoCentral += 46 + nome.length;
  }

  var total = tamanhoLocal + tamanhoCentral + 22;
  var saida = new Uint8Array(total);
  var visao = new DataView(saida.buffer);
  var pos = 0;

  function u32(valor) { visao.setUint32(pos, valor >>> 0, true); pos += 4; }
  function u16(valor) { visao.setUint16(pos, valor & 0xffff, true); pos += 2; }
  function bytes(origem) { saida.set(origem, pos); pos += origem.length; }

  // Cabecalhos locais + conteudo
  for (var a = 0; a < entradas.length; a++) {
    var e = entradas[a];
    u32(0x04034b50);
    u16(20);              // versao necessaria
    u16(0);               // flags (nomes ja sanitizados em ASCII)
    u16(0);               // metodo: store
    u16(carimbo.hora);
    u16(carimbo.dia);
    u32(e.crc);
    u32(e.conteudo.length);
    u32(e.conteudo.length);
    u16(e.nome.length);
    u16(0);               // extra
    bytes(e.nome);
    bytes(e.conteudo);
  }

  // Diretorio central
  var inicioCentral = pos;
  for (var b = 0; b < entradas.length; b++) {
    var c = entradas[b];
    u32(0x02014b50);
    u16(20);              // versao que criou
    u16(20);              // versao necessaria
    u16(0);
    u16(0);
    u16(carimbo.hora);
    u16(carimbo.dia);
    u32(c.crc);
    u32(c.conteudo.length);
    u32(c.conteudo.length);
    u16(c.nome.length);
    u16(0);               // extra
    u16(0);               // comentario
    u16(0);               // disco
    u16(0);               // atributos internos
    u32(0);               // atributos externos
    u32(c.deslocamento);
    bytes(c.nome);
  }

  // Fim do diretorio central.
  // O tamanho do diretorio precisa ser medido ANTES de comecar a escrever este
  // bloco: depois disso, pos ja avancou sobre os campos abaixo.
  var tamanhoDoCentral = pos - inicioCentral;

  u32(0x06054b50);
  u16(0);                    // numero do disco
  u16(0);                    // disco onde o diretorio comeca
  u16(entradas.length);      // entradas neste disco
  u16(entradas.length);      // entradas no total
  u32(tamanhoDoCentral);
  u32(inicioCentral);
  u16(0);                    // comentario

  return saida;
}
