// Motor de legendas do SyncLab.
//
// Tudo converge para uma unica estrutura intermediaria: uma lista de palavras
// com tempo de inicio e fim. As tres origens previstas na especificacao
// (timestamps da ElevenLabs, transcricao do Scribe, SRT/VTT prontos) produzem
// essa mesma lista, e a partir dela as regras de segmentacao montam os blocos.
// Assim, "reaplicar as regras sem regerar o audio" e so rodar segmentar() de novo.

import { normalizarEspacos, tempoSrt, tempoVtt, tempoParaSegundos } from './util.js';

export var REGRAS_PADRAO = Object.freeze({
  maxCaracteresPorLinha: 42,
  maxLinhas: 2,
  pausaMinima: 0.35,
  quebrarEmFimDeFrase: true
});

// Ponto final, exclamacao, interrogacao ou reticencias (U+2026), seguidos
// opcionalmente de aspas/parenteses de fechamento -- inclusive as curvas.
var FIM_DE_FRASE_RE = new RegExp('[.!?\\u2026]["\')\\]\\u201D\\u2019]?$');

/** A palavra encerra uma frase? (ponto, exclamacao, interrogacao, reticencias) */
export function terminaFrase(palavra) {
  return FIM_DE_FRASE_RE.test(String(palavra || '').trim());
}

// ---------------------------------------------------------------------------
// Origem 1: alinhamento por caractere da ElevenLabs (/with-timestamps)
// ---------------------------------------------------------------------------

/**
 * O endpoint devolve tres vetores paralelos: cada caractere falado, o instante
 * em que comeca e o instante em que termina. Agrupamos os caracteres em
 * palavras usando os espacos como separador -- sem transcrever nada.
 *
 * @param {{characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[]}} alinhamento
 * @returns {Array<{texto: string, inicio: number, fim: number}>}
 */
export function palavrasDeAlinhamento(alinhamento) {
  if (!alinhamento) return [];
  var chars = alinhamento.characters || [];
  var inicios = alinhamento.character_start_times_seconds || [];
  var fins = alinhamento.character_end_times_seconds || [];

  var palavras = [];
  var atual = null;

  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i];
    var inicio = Number(inicios[i]);
    var fim = Number(fins[i]);
    if (!Number.isFinite(inicio)) inicio = atual ? atual.fim : 0;
    if (!Number.isFinite(fim)) fim = inicio;

    if (/\s/.test(ch)) {
      if (atual) {
        palavras.push(atual);
        atual = null;
      }
      continue;
    }
    if (!atual) {
      atual = { texto: ch, inicio: inicio, fim: fim };
    } else {
      atual.texto += ch;
      atual.fim = Math.max(atual.fim, fim);
    }
  }
  if (atual) palavras.push(atual);
  return ordenarECorrigir(palavras);
}

// ---------------------------------------------------------------------------
// Origem 2: transcricao do Scribe (/v1/speech-to-text)
// ---------------------------------------------------------------------------

/**
 * O Scribe devolve uma lista de tokens; os que interessam tem type "word".
 * Tokens de espacamento e de evento sonoro (risada, musica) sao descartados.
 */
export function palavrasDeScribe(resposta) {
  if (!resposta) return [];
  var tokens = resposta.words || resposta.segments || [];
  var palavras = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (!t) continue;
    var tipo = t.type || 'word';
    if (tipo !== 'word') continue;
    var texto = String(t.text == null ? t.word : t.text).trim();
    if (!texto) continue;
    palavras.push({
      texto: texto,
      inicio: Number(t.start) || 0,
      fim: Number(t.end) || Number(t.start) || 0
    });
  }
  return ordenarECorrigir(palavras);
}

// ---------------------------------------------------------------------------
// Origem 3: SRT/VTT ja prontos
// ---------------------------------------------------------------------------

/**
 * Le SRT ou VTT. Aceita numeracao opcional, virgula ou ponto nos milissegundos
 * e ignora cabecalhos WEBVTT / NOTE / STYLE.
 *
 * @returns {Array<{inicio: number, fim: number, linhas: string[], texto: string}>}
 */
export function lerLegendas(conteudo) {
  var texto = String(conteudo || '')
    .replace(new RegExp('^\\uFEFF'), '')
    .replace(/\r\n?/g, '\n');

  var blocos = texto.split(/\n{2,}/);
  var cues = [];

  for (var i = 0; i < blocos.length; i++) {
    var linhas = blocos[i].split('\n').filter(function (l) {
      return l.trim() !== '';
    });
    if (!linhas.length) continue;

    var cabecalho = linhas[0].trim();
    if (/^WEBVTT/i.test(cabecalho) || /^(NOTE|STYLE|REGION)\b/i.test(cabecalho)) continue;

    // Numeracao do SRT numa linha sozinha, antes do tempo.
    var idxTempo = 0;
    if (/^\d+$/.test(cabecalho) && linhas.length > 1) idxTempo = 1;

    var tempos = lerLinhaDeTempo(linhas[idxTempo]);
    if (!tempos) continue;

    var corpo = linhas.slice(idxTempo + 1).map(limparMarcacao).filter(function (l) {
      return l !== '';
    });
    if (!corpo.length) continue;

    cues.push({
      inicio: tempos.inicio,
      fim: tempos.fim,
      linhas: corpo,
      texto: corpo.join(' ')
    });
  }

  return numerar(cues);
}

function lerLinhaDeTempo(linha) {
  if (!linha) return null;
  var m = /^\s*([\d:,.]+)\s*-->\s*([\d:,.]+)/.exec(linha);
  if (!m) return null;
  var inicio = tempoParaSegundos(m[1]);
  var fim = tempoParaSegundos(m[2]);
  if (inicio == null || fim == null) return null;
  return { inicio: inicio, fim: Math.max(inicio, fim) };
}

/** Remove tags de estilo do VTT (<v Fulano>, <i>, <00:00:01.000>). */
function limparMarcacao(linha) {
  return String(linha).replace(/<[^>]*>/g, '').trim();
}

/**
 * Converte cues em palavras com tempo estimado, distribuindo a duracao do
 * bloco proporcionalmente ao tamanho de cada palavra. E o que permite
 * reaplicar as regras de segmentacao sobre um SRT importado.
 */
export function palavrasDeCues(cues) {
  var palavras = [];
  for (var i = 0; i < cues.length; i++) {
    var cue = cues[i];
    var partes = normalizarEspacos(cue.texto || (cue.linhas || []).join(' ')).split(' ').filter(Boolean);
    if (!partes.length) continue;

    var duracao = Math.max(0, cue.fim - cue.inicio);
    var totalChars = 0;
    for (var p = 0; p < partes.length; p++) totalChars += partes[p].length;
    if (totalChars === 0) continue;

    var cursor = cue.inicio;
    for (var j = 0; j < partes.length; j++) {
      var fatia = duracao * (partes[j].length / totalChars);
      var fim = j === partes.length - 1 ? cue.fim : cursor + fatia;
      palavras.push({ texto: partes[j], inicio: cursor, fim: fim, estimado: true });
      cursor = fim;
    }
  }
  return ordenarECorrigir(palavras);
}

// ---------------------------------------------------------------------------
// Regras de segmentacao
// ---------------------------------------------------------------------------

/**
 * Agrupa palavras em blocos de legenda respeitando as regras.
 *
 * Um bloco e fechado quando: a pausa ate a proxima palavra atinge o minimo
 * configurado; a palavra anterior encerrou uma frase (se a opcao estiver
 * ligada); ou a proxima palavra nao caberia dentro de maxLinhas x maxCaracteres.
 */
export function segmentar(palavras, regras) {
  var cfg = combinarRegras(regras);
  var lista = ordenarECorrigir(palavras || []);
  if (!lista.length) return [];

  var cues = [];
  var atual = [lista[0]];

  for (var i = 1; i < lista.length; i++) {
    var palavra = lista[i];
    var anterior = atual[atual.length - 1];
    var pausa = palavra.inicio - anterior.fim;

    var fechar = false;
    if (cfg.pausaMinima > 0 && pausa >= cfg.pausaMinima) {
      fechar = true;
    } else if (cfg.quebrarEmFimDeFrase && terminaFrase(anterior.texto)) {
      fechar = true;
    } else if (!cabeNoBloco(atual.concat([palavra]), cfg)) {
      fechar = true;
    }

    if (fechar) {
      cues.push(fecharCue(atual, cfg));
      atual = [palavra];
    } else {
      atual.push(palavra);
    }
  }
  cues.push(fecharCue(atual, cfg));
  return numerar(cues);
}

export function combinarRegras(regras) {
  var r = regras || {};
  return {
    maxCaracteresPorLinha: Math.max(8, Math.round(Number(r.maxCaracteresPorLinha) || REGRAS_PADRAO.maxCaracteresPorLinha)),
    maxLinhas: Math.max(1, Math.round(Number(r.maxLinhas) || REGRAS_PADRAO.maxLinhas)),
    pausaMinima: Math.max(0, Number(r.pausaMinima != null ? r.pausaMinima : REGRAS_PADRAO.pausaMinima)),
    quebrarEmFimDeFrase: r.quebrarEmFimDeFrase !== false
  };
}

function cabeNoBloco(palavras, cfg) {
  return quebrarEmLinhas(textoDe(palavras), cfg.maxCaracteresPorLinha).length <= cfg.maxLinhas;
}

function textoDe(palavras) {
  var partes = [];
  for (var i = 0; i < palavras.length; i++) partes.push(palavras[i].texto);
  return partes.join(' ');
}

function fecharCue(palavras, cfg) {
  var texto = textoDe(palavras);
  return {
    inicio: palavras[0].inicio,
    fim: Math.max(palavras[palavras.length - 1].fim, palavras[0].inicio),
    texto: texto,
    linhas: quebrarEmLinhas(texto, cfg.maxCaracteresPorLinha)
  };
}

/**
 * Quebra gulosa por palavra. Uma palavra maior que o limite fica sozinha na
 * linha em vez de ser cortada no meio -- cortar termo medico e pior que
 * estourar a largura.
 */
export function quebrarEmLinhas(texto, maxCaracteres) {
  var limite = Math.max(1, Math.round(Number(maxCaracteres) || REGRAS_PADRAO.maxCaracteresPorLinha));
  var palavras = normalizarEspacos(texto).split(' ').filter(Boolean);
  if (!palavras.length) return [];

  var linhas = [];
  var atual = '';
  for (var i = 0; i < palavras.length; i++) {
    var p = palavras[i];
    if (atual === '') {
      atual = p;
    } else if ((atual + ' ' + p).length <= limite) {
      atual += ' ' + p;
    } else {
      linhas.push(atual);
      atual = p;
    }
  }
  if (atual !== '') linhas.push(atual);
  return linhas;
}

/** Reaplica somente a quebra de linhas, preservando os tempos dos blocos. */
export function reaplicarQuebraDeLinhas(cues, regras) {
  var cfg = combinarRegras(regras);
  return numerar(
    (cues || []).map(function (cue) {
      var texto = cue.texto || (cue.linhas || []).join(' ');
      return {
        inicio: cue.inicio,
        fim: cue.fim,
        texto: texto,
        linhas: quebrarEmLinhas(texto, cfg.maxCaracteresPorLinha)
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Saida
// ---------------------------------------------------------------------------

export function paraSrt(cues) {
  var partes = [];
  for (var i = 0; i < cues.length; i++) {
    var c = cues[i];
    partes.push(
      String(i + 1) + '\n' +
      tempoSrt(c.inicio) + ' --> ' + tempoSrt(c.fim) + '\n' +
      linhasDe(c).join('\n')
    );
  }
  return partes.join('\n\n') + (partes.length ? '\n' : '');
}

export function paraVtt(cues) {
  var partes = ['WEBVTT'];
  for (var i = 0; i < cues.length; i++) {
    var c = cues[i];
    partes.push(
      tempoVtt(c.inicio) + ' --> ' + tempoVtt(c.fim) + '\n' +
      linhasDe(c).join('\n')
    );
  }
  return partes.join('\n\n') + '\n';
}

function linhasDe(cue) {
  if (cue.linhas && cue.linhas.length) return cue.linhas;
  return [String(cue.texto || '')];
}

/** Forma enxuta embutida no HTML gerado: [inicio, fim, "linha1\nlinha2"]. */
export function paraFormatoCompacto(cues) {
  return (cues || []).map(function (c) {
    return [
      Number(c.inicio.toFixed(3)),
      Number(c.fim.toFixed(3)),
      linhasDe(c).join('\n')
    ];
  });
}

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------

/**
 * Ordena por tempo e conserta inconsistencias comuns dos provedores:
 * fim antes do inicio, e sobreposicao entre palavras vizinhas.
 */
function ordenarECorrigir(palavras) {
  var lista = (palavras || [])
    .filter(function (p) {
      return p && String(p.texto || '').trim() !== '';
    })
    .map(function (p) {
      var inicio = Number(p.inicio) || 0;
      var fim = Number(p.fim);
      if (!Number.isFinite(fim) || fim < inicio) fim = inicio;
      return { texto: String(p.texto).trim(), inicio: inicio, fim: fim, estimado: !!p.estimado };
    })
    .sort(function (a, b) {
      return a.inicio - b.inicio || a.fim - b.fim;
    });

  for (var i = 1; i < lista.length; i++) {
    if (lista[i].inicio < lista[i - 1].fim) lista[i - 1].fim = lista[i].inicio;
  }
  return lista;
}

function numerar(cues) {
  return (cues || []).map(function (c, i) {
    return {
      indice: i + 1,
      inicio: c.inicio,
      fim: c.fim,
      texto: c.texto || (c.linhas || []).join(' '),
      linhas: linhasDe(c)
    };
  });
}

/** Estatisticas para a tabela de blocos da pre-visualizacao. */
export function resumo(cues) {
  var lista = cues || [];
  if (!lista.length) return { blocos: 0, duracao: 0, maiorLinha: 0, caracteres: 0 };
  var maiorLinha = 0;
  var caracteres = 0;
  for (var i = 0; i < lista.length; i++) {
    var linhas = linhasDe(lista[i]);
    for (var j = 0; j < linhas.length; j++) {
      maiorLinha = Math.max(maiorLinha, linhas[j].length);
      caracteres += linhas[j].length;
    }
  }
  return {
    blocos: lista.length,
    duracao: lista[lista.length - 1].fim,
    maiorLinha: maiorLinha,
    caracteres: caracteres
  };
}
