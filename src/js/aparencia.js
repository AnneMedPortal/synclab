// Aparencia da legenda.
//
// Este modulo e a unica fonte do CSS da legenda. A pre-visualizacao e o HTML
// exportado chamam a mesma funcao, entao o que se ve na tela e exatamente o
// que o aluno vai ver -- nao ha um CSS "de preview" e outro "de producao".
//
// Tres decisoes aqui nao sao negociaveis, e estao marcadas no codigo:
//   1. fundo do container sempre transparente (o slide do Genially aparece atras);
//   2. a caixa usa width:max-content (abraca o texto, nunca vira faixa larga);
//   3. nada alem da linha de legenda e visivel (sem player, sem controles).

import { cssAscii, numeroEmFaixa } from './util.js';

export var FONTES = [
  { valor: 'Arial, Helvetica, sans-serif', rotulo: 'Arial' },
  { valor: '"Helvetica Neue", Helvetica, Arial, sans-serif', rotulo: 'Helvetica' },
  { valor: 'Verdana, Geneva, sans-serif', rotulo: 'Verdana' },
  { valor: 'Tahoma, Geneva, sans-serif', rotulo: 'Tahoma' },
  { valor: '"Trebuchet MS", Helvetica, sans-serif', rotulo: 'Trebuchet MS' },
  { valor: 'Georgia, "Times New Roman", serif', rotulo: 'Georgia' },
  { valor: '"Times New Roman", Times, serif', rotulo: 'Times New Roman' },
  { valor: '"Courier New", Courier, monospace', rotulo: 'Courier New' },
  { valor: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', rotulo: 'Fonte do sistema' }
];

export var APARENCIA_PADRAO = Object.freeze({
  fonte: 'Arial, Helvetica, sans-serif',
  tamanho: 32,
  peso: 700,
  corTexto: '#FFFFFF',
  corTarja: '#000000',
  opacidadeTarja: 0.75,
  mostrarTarja: true,
  posicaoVertical: 'base',
  distanciaBorda: 48,
  alinhamentoHorizontal: 'centro',
  espacamentoLinha: 1.25,
  recuoHorizontal: 18,
  recuoVertical: 10,
  raioBorda: 8,
  contorno: true,
  larguraMaxima: 90,
  ancoragem: 'fixed'
});

export function combinarAparencia(aparencia) {
  var a = aparencia || {};
  return {
    fonte: String(a.fonte || APARENCIA_PADRAO.fonte),
    tamanho: numeroEmFaixa(a.tamanho, 8, 200, APARENCIA_PADRAO.tamanho),
    peso: numeroEmFaixa(a.peso, 100, 900, APARENCIA_PADRAO.peso),
    corTexto: normalizarCor(a.corTexto, APARENCIA_PADRAO.corTexto),
    corTarja: normalizarCor(a.corTarja, APARENCIA_PADRAO.corTarja),
    opacidadeTarja: numeroEmFaixa(a.opacidadeTarja, 0, 1, APARENCIA_PADRAO.opacidadeTarja),
    mostrarTarja: a.mostrarTarja !== false,
    posicaoVertical: ['topo', 'centro', 'base'].indexOf(a.posicaoVertical) >= 0
      ? a.posicaoVertical
      : APARENCIA_PADRAO.posicaoVertical,
    distanciaBorda: numeroEmFaixa(a.distanciaBorda, 0, 1000, APARENCIA_PADRAO.distanciaBorda),
    alinhamentoHorizontal: ['esquerda', 'centro', 'direita'].indexOf(a.alinhamentoHorizontal) >= 0
      ? a.alinhamentoHorizontal
      : APARENCIA_PADRAO.alinhamentoHorizontal,
    espacamentoLinha: numeroEmFaixa(a.espacamentoLinha, 0.8, 3, APARENCIA_PADRAO.espacamentoLinha),
    recuoHorizontal: numeroEmFaixa(a.recuoHorizontal, 0, 200, APARENCIA_PADRAO.recuoHorizontal),
    recuoVertical: numeroEmFaixa(a.recuoVertical, 0, 200, APARENCIA_PADRAO.recuoVertical),
    raioBorda: numeroEmFaixa(a.raioBorda, 0, 100, APARENCIA_PADRAO.raioBorda),
    contorno: !!a.contorno,
    larguraMaxima: numeroEmFaixa(a.larguraMaxima, 10, 100, APARENCIA_PADRAO.larguraMaxima),
    ancoragem: ['fixed', 'absolute', 'estatico'].indexOf(a.ancoragem) >= 0
      ? a.ancoragem
      : APARENCIA_PADRAO.ancoragem
  };
}

/** Aceita #RGB e #RRGGBB; devolve sempre #RRGGBB maiusculo. */
export function normalizarCor(cor, padrao) {
  var texto = String(cor == null ? '' : cor).trim();
  var curto = /^#?([0-9a-fA-F]{3})$/.exec(texto);
  if (curto) {
    var c = curto[1];
    return ('#' + c[0] + c[0] + c[1] + c[1] + c[2] + c[2]).toUpperCase();
  }
  var longo = /^#?([0-9a-fA-F]{6})$/.exec(texto);
  if (longo) return ('#' + longo[1]).toUpperCase();
  return padrao || '#000000';
}

/** #RRGGBB + opacidade -> rgba(r,g,b,a). */
export function corComOpacidade(cor, opacidade) {
  var hex = normalizarCor(cor, '#000000').slice(1);
  var r = parseInt(hex.slice(0, 2), 16);
  var g = parseInt(hex.slice(2, 4), 16);
  var b = parseInt(hex.slice(4, 6), 16);
  var a = Math.round(numeroEmFaixa(opacidade, 0, 1, 1) * 1000) / 1000;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

var ALINHAMENTO_CSS = { esquerda: 'flex-start', centro: 'center', direita: 'flex-end' };
var TEXTO_CSS = { esquerda: 'left', centro: 'center', direita: 'right' };

/**
 * Monta o CSS completo do trecho, isolado pelo prefixo unico.
 *
 * @param {string} prefixo identificador unico do trecho (evita colisao entre
 *   dois SyncLab na mesma pagina)
 * @param {object} aparencia
 * @returns {string} CSS em ASCII puro
 */
export function cssDaLegenda(prefixo, aparencia) {
  var a = combinarAparencia(aparencia);
  var raiz = '.' + prefixo + '-raiz';
  var caixa = '.' + prefixo + '-caixa';

  var fundoCaixa = a.mostrarTarja ? corComOpacidade(a.corTarja, a.opacidadeTarja) : 'transparent';

  // Sem tarja, o texto encosta direto no slide; o contorno garante leitura
  // sobre fundo claro sem reintroduzir a faixa.
  var sombra = a.contorno
    ? '0 1px 2px rgba(0,0,0,.9),0 -1px 2px rgba(0,0,0,.9),1px 0 2px rgba(0,0,0,.9),-1px 0 2px rgba(0,0,0,.9)'
    : 'none';

  var posicaoRaiz;
  if (a.ancoragem === 'estatico') {
    posicaoRaiz = 'position:relative;width:100%;';
  } else {
    posicaoRaiz = 'position:' + a.ancoragem + ';top:0;right:0;bottom:0;left:0;';
  }

  var alinhamentoVertical =
    a.posicaoVertical === 'topo' ? 'flex-start' :
    a.posicaoVertical === 'centro' ? 'center' : 'flex-end';

  var recuoTopo = a.posicaoVertical === 'topo' ? a.distanciaBorda : 0;
  var recuoBase = a.posicaoVertical === 'base' ? a.distanciaBorda : 0;

  var linhas = [];

  linhas.push(raiz + '{');
  linhas.push('  ' + posicaoRaiz);
  linhas.push('  display:flex;');
  linhas.push('  align-items:' + alinhamentoVertical + ';');
  linhas.push('  justify-content:' + ALINHAMENTO_CSS[a.alinhamentoHorizontal] + ';');
  linhas.push('  padding:' + recuoTopo + 'px 16px ' + recuoBase + 'px 16px;');
  // Fundo transparente: o slide do Genially precisa aparecer por tras.
  linhas.push('  background:transparent;');
  // Nao intercepta cliques: o aluno continua interagindo com o slide.
  linhas.push('  pointer-events:none;');
  linhas.push('  z-index:2147483000;');
  linhas.push('  box-sizing:border-box;');
  linhas.push('  margin:0;');
  linhas.push('}');

  linhas.push(caixa + '{');
  // max-content: a caixa abraca o texto e nunca vira uma faixa da largura toda.
  linhas.push('  width:max-content;');
  linhas.push('  max-width:' + a.larguraMaxima + '%;');
  linhas.push('  box-sizing:border-box;');
  linhas.push('  font-family:' + cssAscii(a.fonte) + ';');
  linhas.push('  font-size:' + a.tamanho + 'px;');
  linhas.push('  font-weight:' + a.peso + ';');
  linhas.push('  line-height:' + a.espacamentoLinha + ';');
  linhas.push('  color:' + a.corTexto + ';');
  linhas.push('  background-color:' + fundoCaixa + ';');
  linhas.push('  padding:' + a.recuoVertical + 'px ' + a.recuoHorizontal + 'px;');
  linhas.push('  border-radius:' + a.raioBorda + 'px;');
  linhas.push('  text-align:' + TEXTO_CSS[a.alinhamentoHorizontal] + ';');
  linhas.push('  text-shadow:' + sombra + ';');
  // pre-line preserva a quebra em duas linhas decidida pela segmentacao.
  linhas.push('  white-space:pre-line;');
  linhas.push('  overflow-wrap:break-word;');
  linhas.push('  opacity:0;');
  linhas.push('  transition:opacity 120ms linear;');
  linhas.push('  pointer-events:none;');
  linhas.push('  margin:0;');
  linhas.push('}');

  // Entre um bloco e outro nao sobra caixa vazia piscando na tela.
  linhas.push(caixa + '[data-visivel="1"]{opacity:1;}');

  // O elemento de audio existe, mas o aluno nunca o ve nem o alcanca.
  linhas.push('.' + prefixo + '-audio{');
  linhas.push('  position:absolute;width:1px;height:1px;opacity:0;');
  linhas.push('  pointer-events:none;left:-9999px;top:auto;');
  linhas.push('}');

  return linhas.join('\n') + '\n';
}

/** CSS do painel de diagnostico (so entra quando o painel esta ligado). */
export function cssDoDiagnostico(prefixo) {
  var d = '.' + prefixo + '-diag';
  return [
    d + '{',
    '  position:fixed;top:8px;left:8px;z-index:2147483600;',
    '  font:12px/1.45 ui-monospace,Menlo,Consolas,"Courier New",monospace;',
    '  color:#E6FFE6;background:rgba(0,0,0,.86);',
    '  border:1px solid #35C46A;border-radius:6px;',
    '  padding:8px 10px;max-width:min(420px,90vw);',
    '  pointer-events:auto;white-space:pre-wrap;word-break:break-all;',
    '}',
    d + ' b{color:#8BE9A0;font-weight:700;}',
    d + ' .' + prefixo + '-erro{color:#FF9C9C;}',
    d + ' .' + prefixo + '-ok{color:#8BE9A0;}',
    d + ' .' + prefixo + '-alerta{color:#FFD479;}',
    ''
  ].join('\n');
}
