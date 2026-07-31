// Ligacao entre a interface e os modulos do SyncLab.

import {
  limparInvisiveis, sanitizarNomeArquivo, tempoSrt, formatarDuracao,
  textoParaBytes, numeroEmFaixa
} from './util.js';
import { ClienteElevenLabs, MODELOS_SUGERIDOS, validarRegra, ErroElevenLabs } from './elevenlabs.js';
import {
  segmentar, palavrasDeAlinhamento, palavrasDeScribe, palavrasDeCues,
  lerLegendas, paraSrt, paraVtt, resumo, REGRAS_PADRAO
} from './legendas.js';
import { FONTES, APARENCIA_PADRAO, cssDaLegenda, combinarAparencia } from './aparencia.js';
import { gerarTrechoInline, gerarDocumentoCompleto, pesoLegivel, ErroGeracao } from './gerador.js';
import { enviarParaS3, montarChave, testarUrlDeAudio, ErroS3 } from './s3.js';
import { montarZip } from './zip.js';

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

var estado = {
  cliente: null,
  vozes: [],
  modelos: [],
  palavras: [],
  cues: [],
  audioBytes: null,
  audioTipo: 'audio/mpeg',
  audioUrlObjeto: '',
  origem: 'texto',
  regrasDicionario: [],
  dicionario: null,
  saida: null,
  linkS3: ''
};

var CHAVE_PREFS = 'synclab.preferencias';
var CHAVE_SEGREDOS = 'synclab.credenciais';

function $(id) { return document.getElementById(id); }
function todos(seletor) { return Array.prototype.slice.call(document.querySelectorAll(seletor)); }

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

var cronometroNotificacao = null;

function notificar(mensagem, tipo) {
  var el = $('notificacao');
  el.textContent = mensagem;
  el.className = 'notificacao' + (tipo ? ' ' + tipo : '');
  window.clearTimeout(cronometroNotificacao);
  cronometroNotificacao = window.setTimeout(function () {
    el.classList.add('oculto');
  }, tipo === 'erro' ? 12000 : 5000);
}

function mostrarAviso(id, mensagem, tipo) {
  var el = $(id);
  if (!mensagem) {
    el.classList.add('oculto');
    el.textContent = '';
    return;
  }
  el.textContent = mensagem;
  el.className = 'aviso aviso-' + (tipo || 'alerta');
}

/** Converte qualquer erro numa mensagem util em portugues. */
function mensagemDeErro(erro) {
  if (erro instanceof ErroElevenLabs || erro instanceof ErroS3 || erro instanceof ErroGeracao) {
    return erro.message;
  }
  if (erro && erro.name === 'TypeError' && /fetch/i.test(erro.message || '')) {
    return 'Falha de rede. Verifique a conexão com a internet e tente novamente.';
  }
  return (erro && erro.message) ? erro.message : String(erro);
}

function ocupado(botao, ativo, textoOcupado) {
  if (!botao) return;
  if (ativo) {
    botao.dataset.rotulo = botao.textContent;
    botao.textContent = textoOcupado || 'Aguarde...';
    botao.disabled = true;
  } else {
    if (botao.dataset.rotulo) botao.textContent = botao.dataset.rotulo;
    botao.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Leitura dos formularios
// ---------------------------------------------------------------------------

function lerRegras() {
  return {
    maxCaracteresPorLinha: numeroEmFaixa($('max-caracteres').value, 8, 120, REGRAS_PADRAO.maxCaracteresPorLinha),
    maxLinhas: numeroEmFaixa($('max-linhas').value, 1, 4, REGRAS_PADRAO.maxLinhas),
    pausaMinima: numeroEmFaixa($('pausa-minima').value, 0, 3, REGRAS_PADRAO.pausaMinima),
    quebrarEmFimDeFrase: $('quebrar-frase').checked
  };
}

function lerAparencia() {
  return combinarAparencia({
    fonte: $('ap-fonte').value,
    tamanho: $('ap-tamanho').value,
    peso: $('ap-peso').value,
    corTexto: $('ap-cor-texto').value,
    corTarja: $('ap-cor-tarja').value,
    opacidadeTarja: Number($('ap-opacidade').value) / 100,
    mostrarTarja: $('ap-mostrar-tarja').checked,
    contorno: $('ap-contorno').checked,
    posicaoVertical: $('ap-posicao').value,
    distanciaBorda: $('ap-distancia').value,
    alinhamentoHorizontal: $('ap-alinhamento').value,
    recuoHorizontal: $('ap-recuo-h').value,
    recuoVertical: $('ap-recuo-v').value,
    raioBorda: $('ap-raio').value,
    espacamentoLinha: $('ap-entrelinha').value,
    largura: $('ap-largura').value,
    larguraMaxima: $('ap-largura').value,
    ancoragem: $('ap-ancoragem').value
  });
}

function lerConfigS3() {
  return {
    bucket: $('s3-bucket').value,
    regiao: $('s3-regiao').value,
    prefixo: $('s3-prefixo').value,
    chaveAcesso: $('s3-chave').value,
    segredo: $('s3-segredo').value,
    token: $('s3-token').value,
    publico: $('s3-publico').checked
  };
}

function nomeBase() {
  return sanitizarNomeArquivo($('nome-base').value, 'narracao');
}

function clienteOuErro() {
  if (estado.cliente) return estado.cliente;
  var chave = limparInvisiveis($('chave-api').value);
  if (!chave) {
    throw new ErroElevenLabs('Informe a chave de API da ElevenLabs na seção 1 antes de continuar.');
  }
  estado.cliente = new ClienteElevenLabs(chave);
  return estado.cliente;
}

// ---------------------------------------------------------------------------
// Secao 1: conexao
// ---------------------------------------------------------------------------

async function conectar() {
  var botao = $('btn-conectar');
  var campo = $('chave-api');
  var limpa = limparInvisiveis(campo.value);
  if (limpa !== campo.value) campo.value = limpa;

  mostrarAviso('aviso-conexao', '');
  ocupado(botao, true, 'Conectando...');
  try {
    estado.cliente = new ClienteElevenLabs(limpa);
    var resultado = await Promise.all([
      estado.cliente.listarVozes(),
      estado.cliente.listarModelos()
    ]);
    estado.vozes = resultado[0];
    estado.modelos = resultado[1];

    preencherVozes();
    preencherModelos();
    marcarPastilha('estado-conexao', true, estado.vozes.length + ' vozes carregadas');

    try {
      var assinatura = await estado.cliente.assinatura();
      if (assinatura.limite) {
        mostrarAviso(
          'aviso-conexao',
          'Conectado. Plano ' + (assinatura.plano || 'atual') + ': ' +
          assinatura.usados + ' de ' + assinatura.limite + ' caracteres usados.',
          'ok'
        );
      }
    } catch (e) { /* creditos sao informativos; falhar aqui nao impede nada */ }

    salvarPreferencias();
    notificar('Conectado à ElevenLabs.', 'ok');
  } catch (erro) {
    estado.cliente = null;
    marcarPastilha('estado-conexao', false, 'Falha na conexão');
    mostrarAviso('aviso-conexao', mensagemDeErro(erro), 'erro');
    notificar(mensagemDeErro(erro), 'erro');
  } finally {
    ocupado(botao, false);
  }
}

function preencherVozes() {
  var sel = $('voz');
  sel.innerHTML = '';
  estado.vozes.forEach(function (v) {
    var op = document.createElement('option');
    op.value = v.id;
    op.textContent = v.nome + (v.categoria ? ' (' + v.categoria + ')' : '');
    sel.appendChild(op);
  });
  sel.disabled = estado.vozes.length === 0;
  var salva = lerPreferencias().vozId;
  if (salva && estado.vozes.some(function (v) { return v.id === salva; })) sel.value = salva;
  $('voz-id').value = sel.value || '';
}

function preencherModelos() {
  var sel = $('modelo');
  sel.innerHTML = '';
  var ordenados = estado.modelos.slice().sort(function (a, b) {
    var pa = MODELOS_SUGERIDOS.findIndex(function (m) { return m.id === a.id; });
    var pb = MODELOS_SUGERIDOS.findIndex(function (m) { return m.id === b.id; });
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
  });
  ordenados.forEach(function (m) {
    var op = document.createElement('option');
    op.value = m.id;
    op.textContent = m.nome;
    sel.appendChild(op);
  });
  sel.disabled = ordenados.length === 0;
  var salvo = lerPreferencias().modeloId;
  if (salvo && ordenados.some(function (m) { return m.id === salvo; })) sel.value = salvo;
  else if (ordenados.some(function (m) { return m.id === 'eleven_multilingual_v2'; })) {
    sel.value = 'eleven_multilingual_v2';
  }
  atualizarNotaModelo();
}

function atualizarNotaModelo() {
  var id = $('modelo').value;
  var sugerido = MODELOS_SUGERIDOS.filter(function (m) { return m.id === id; })[0];
  $('nota-modelo').textContent = sugerido ? sugerido.nota : '';
}

function marcarPastilha(id, ok, texto) {
  var el = $(id);
  el.textContent = texto;
  el.className = 'pastilha ' + (ok ? 'pastilha-ok' : 'pastilha-erro');
}

// ---------------------------------------------------------------------------
// Secao 3: geracao / importacao / transcricao
// ---------------------------------------------------------------------------

async function gerarComTimestamps() {
  var botao = $('btn-gerar');
  mostrarAviso('aviso-legenda', '');
  var texto = $('texto').value.trim();
  if (!texto) {
    notificar('Escreva o texto da narração na seção 2.', 'erro');
    return;
  }

  ocupado(botao, true, 'Gerando...');
  try {
    var cliente = clienteOuErro();
    var vozId = $('voz-id').value || $('voz').value;
    if (!vozId) throw new ErroElevenLabs('Escolha uma voz na seção 1.');

    var dicionarios = [];
    if ($('aplicar-dicionario').checked && estado.dicionario) {
      dicionarios.push(estado.dicionario);
    }

    var resultado = await cliente.gerarAudioComTimestamps({
      texto: texto,
      vozId: vozId,
      modelo: $('modelo').value || 'eleven_multilingual_v2',
      velocidade: Number($('velocidade').value) || 1,
      dicionarios: dicionarios
    });

    if (!resultado.alinhamento) {
      throw new ErroElevenLabs(
        'A ElevenLabs devolveu o áudio sem os timestamps. Use a aba "Só o áudio" ' +
        'para transcrever pelo Scribe.'
      );
    }

    definirAudio(resultado.audio, 'audio/mpeg');
    estado.palavras = palavrasDeAlinhamento(resultado.alinhamento);
    aplicarSegmentacao();
    mostrarAviso(
      'aviso-legenda',
      'Áudio e legenda gerados juntos: ' + estado.palavras.length +
      ' palavras com tempo próprio, sem transcrição no meio.',
      'ok'
    );
    notificar('Áudio e legenda gerados.', 'ok');
  } catch (erro) {
    mostrarAviso('aviso-legenda', mensagemDeErro(erro), 'erro');
    notificar(mensagemDeErro(erro), 'erro');
  } finally {
    ocupado(botao, false);
  }
}

async function importarArquivos() {
  var botao = $('btn-importar');
  mostrarAviso('aviso-legenda', '');
  var arqAudio = $('arq-audio').files[0];
  var arqLegenda = $('arq-legenda').files[0];

  if (!arqAudio && !arqLegenda) {
    notificar('Escolha ao menos um arquivo para importar.', 'erro');
    return;
  }

  ocupado(botao, true, 'Importando...');
  try {
    if (arqAudio) {
      var bytes = new Uint8Array(await arqAudio.arrayBuffer());
      definirAudio(bytes, arqAudio.type || 'audio/mpeg');
    }
    if (arqLegenda) {
      var conteudo = await arqLegenda.text();
      var cues = lerLegendas(conteudo);
      if (!cues.length) {
        throw new ErroGeracao(
          'Nenhum bloco foi encontrado no arquivo. Confira se é mesmo um SRT ou VTT ' +
          'válido, com as linhas de tempo no formato 00:00:00,000 --> 00:00:02,000.'
        );
      }
      estado.cues = cues;
      // Palavras com tempo estimado: e o que permite reaplicar as regras depois.
      estado.palavras = palavrasDeCues(cues);
      atualizarBlocos();
      mostrarAviso(
        'aviso-legenda',
        cues.length + ' blocos importados. Os tempos vieram do arquivo; ' +
        'se você reaplicar as regras, os tempos de cada palavra serão estimados ' +
        'proporcionalmente dentro de cada bloco original.',
        'ok'
      );
    }
    notificar('Importação concluída.', 'ok');
  } catch (erro) {
    mostrarAviso('aviso-legenda', mensagemDeErro(erro), 'erro');
    notificar(mensagemDeErro(erro), 'erro');
  } finally {
    ocupado(botao, false);
  }
}

async function transcrever() {
  var botao = $('btn-transcrever');
  mostrarAviso('aviso-legenda', '');
  var arquivo = $('arq-audio-transcrever').files[0];
  if (!arquivo) {
    notificar('Escolha o arquivo de áudio a transcrever.', 'erro');
    return;
  }

  ocupado(botao, true, 'Transcrevendo...');
  try {
    var cliente = clienteOuErro();
    var bytes = new Uint8Array(await arquivo.arrayBuffer());
    definirAudio(bytes, arquivo.type || 'audio/mpeg');

    var resposta = await cliente.transcrever(arquivo, {
      idioma: limparInvisiveis($('idioma-scribe').value) || undefined,
      nomeArquivo: arquivo.name
    });
    estado.palavras = palavrasDeScribe(resposta);
    if (!estado.palavras.length) {
      throw new ErroElevenLabs(
        'O Scribe não devolveu palavras com tempo. Verifique se o áudio tem fala audível.'
      );
    }
    aplicarSegmentacao();
    mostrarAviso(
      'aviso-legenda',
      'Transcrição concluída: ' + estado.palavras.length + ' palavras com timestamp.',
      'ok'
    );
    notificar('Transcrição concluída.', 'ok');
  } catch (erro) {
    mostrarAviso('aviso-legenda', mensagemDeErro(erro), 'erro');
    notificar(mensagemDeErro(erro), 'erro');
  } finally {
    ocupado(botao, false);
  }
}

function definirAudio(bytes, tipo) {
  estado.audioBytes = bytes;
  estado.audioTipo = tipo || 'audio/mpeg';
  if (estado.audioUrlObjeto) URL.revokeObjectURL(estado.audioUrlObjeto);
  var blob = new Blob([bytes], { type: estado.audioTipo });
  estado.audioUrlObjeto = URL.createObjectURL(blob);
  $('previa-audio').src = estado.audioUrlObjeto;
  $('previa-info').textContent = 'Áudio carregado (' + pesoLegivel(bytes.length) + ').';
  marcarPastilha('estado-audio', true, 'Áudio: ' + pesoLegivel(bytes.length));
  atualizarBotoesDeSaida();
}

// ---------------------------------------------------------------------------
// Secao 4: dicionario
// ---------------------------------------------------------------------------

function adicionarRegra() {
  var regra = {
    termo: limparInvisiveis($('regra-termo').value),
    tipo: $('regra-tipo').value,
    valor: limparInvisiveis($('regra-valor').value)
  };
  var problema = validarRegra(regra);
  if (problema) {
    notificar(problema, 'erro');
    return;
  }
  estado.regrasDicionario.push(regra);
  $('regra-termo').value = '';
  $('regra-valor').value = '';
  $('regra-termo').focus();
  desenharRegras();
  salvarPreferencias();
}

function desenharRegras() {
  var corpo = $('tabela-regras').querySelector('tbody');
  corpo.innerHTML = '';
  estado.regrasDicionario.forEach(function (regra, indice) {
    var tr = document.createElement('tr');

    var tdTermo = document.createElement('td');
    tdTermo.textContent = regra.termo;
    var tdTipo = document.createElement('td');
    tdTipo.textContent = regra.tipo === 'fonema' ? 'Fonema (IPA)' : 'Substituição';
    var tdValor = document.createElement('td');
    tdValor.textContent = regra.valor;

    var tdAcao = document.createElement('td');
    var remover = document.createElement('button');
    remover.type = 'button';
    remover.className = 'secundario';
    remover.textContent = 'Remover';
    remover.addEventListener('click', function () {
      estado.regrasDicionario.splice(indice, 1);
      desenharRegras();
      salvarPreferencias();
    });
    tdAcao.appendChild(remover);

    tr.appendChild(tdTermo);
    tr.appendChild(tdTipo);
    tr.appendChild(tdValor);
    tr.appendChild(tdAcao);
    corpo.appendChild(tr);
  });
  $('regras-vazio').classList.toggle('oculto', estado.regrasDicionario.length > 0);
  $('tabela-regras').classList.toggle('oculto', estado.regrasDicionario.length === 0);
}

async function salvarDicionario() {
  var botao = $('btn-salvar-dicionario');
  mostrarAviso('estado-dicionario', '');
  if (!estado.regrasDicionario.length) {
    notificar('Cadastre ao menos uma regra antes de salvar.', 'erro');
    return;
  }

  ocupado(botao, true, 'Salvando...');
  try {
    var cliente = clienteOuErro();
    var nome = limparInvisiveis($('dicionario-nome').value) || 'synclab';
    var resultado;
    if (estado.dicionario && estado.dicionario.nome === nome) {
      resultado = await cliente.adicionarRegras(estado.dicionario.id, estado.regrasDicionario);
      resultado.nome = nome;
    } else {
      resultado = await cliente.criarDicionario(nome, estado.regrasDicionario);
    }
    estado.dicionario = resultado;
    mostrarAviso(
      'estado-dicionario',
      'Dicionário salvo na conta ElevenLabs.\nid: ' + resultado.id +
      '\nversão: ' + resultado.versao +
      '\nAs próximas gerações vão aplicá-lo automaticamente enquanto a opção abaixo estiver marcada.',
      'ok'
    );
    notificar('Dicionário salvo.', 'ok');
  } catch (erro) {
    mostrarAviso('estado-dicionario', mensagemDeErro(erro), 'erro');
    notificar(mensagemDeErro(erro), 'erro');
  } finally {
    ocupado(botao, false);
  }
}

// ---------------------------------------------------------------------------
// Secao 5 e 7: segmentacao, previa e tabela
// ---------------------------------------------------------------------------

function aplicarSegmentacao() {
  if (!estado.palavras.length) {
    notificar('Não há palavras com tempo para segmentar. Gere, importe ou transcreva antes.', 'erro');
    return;
  }
  estado.cues = segmentar(estado.palavras, lerRegras());
  atualizarBlocos();
}

function reaplicarRegras() {
  if (!estado.palavras.length && estado.cues.length) {
    estado.palavras = palavrasDeCues(estado.cues);
  }
  aplicarSegmentacao();
  notificar('Regras reaplicadas: ' + estado.cues.length + ' blocos. O áudio não foi tocado.', 'ok');
}

function atualizarBlocos() {
  var corpo = $('tabela-blocos').querySelector('tbody');
  corpo.innerHTML = '';

  estado.cues.forEach(function (cue) {
    var tr = document.createElement('tr');
    tr.dataset.inicio = String(cue.inicio);

    function celula(texto, classe) {
      var td = document.createElement('td');
      td.textContent = texto;
      if (classe) td.className = classe;
      return td;
    }

    tr.appendChild(celula(String(cue.indice), 'numerico'));
    tr.appendChild(celula(tempoSrt(cue.inicio), 'numerico'));
    tr.appendChild(celula(tempoSrt(cue.fim), 'numerico'));
    tr.appendChild(celula((cue.fim - cue.inicio).toFixed(2) + 's', 'numerico'));
    tr.appendChild(celula(cue.linhas.join('\n'), 'texto-bloco'));

    tr.addEventListener('click', function () {
      var audio = $('previa-audio');
      if (audio.src) {
        audio.currentTime = cue.inicio;
        audio.play().catch(function () { /* o usuario decide quando tocar */ });
      }
    });
    corpo.appendChild(tr);
  });

  var r = resumo(estado.cues);
  $('blocos-vazio').classList.toggle('oculto', estado.cues.length > 0);
  $('resumo-blocos').textContent = estado.cues.length
    ? r.blocos + ' blocos, ' + formatarDuracao(r.duracao) + ' no total, linha mais longa com ' +
      r.maiorLinha + ' caracteres. Clique numa linha para ouvir a partir dela.'
    : '—';

  marcarPastilha('estado-legendas', estado.cues.length > 0,
    estado.cues.length ? estado.cues.length + ' blocos' : 'Sem legenda');

  atualizarPrevia();
  atualizarBotoesDeSaida();
  estado.saida = null;
  $('saida-trecho').value = '';
}

/**
 * Aplica na previa exatamente o CSS que sera exportado, so trocando a
 * ancoragem para caber dentro da moldura da ferramenta.
 */
function atualizarPrevia() {
  var aparencia = lerAparencia();
  aparencia.ancoragem = 'absolute';
  $('estilo-previa').textContent = cssDaLegenda('previa', aparencia)
    .replace(/\.previa-raiz/g, '#previa-raiz')
    .replace(/\.previa-caixa/g, '#previa-caixa');
}

function acompanharPrevia() {
  var audio = $('previa-audio');
  var caixa = $('previa-caixa');
  var atual = -2;

  function quadro() {
    var t = audio.currentTime;
    var achado = -1;
    for (var i = 0; i < estado.cues.length; i++) {
      if (t >= estado.cues[i].inicio && t <= estado.cues[i].fim) { achado = i; break; }
    }
    if (achado !== atual) {
      atual = achado;
      if (achado < 0) {
        caixa.setAttribute('data-visivel', '0');
      } else {
        caixa.textContent = estado.cues[achado].linhas.join('\n');
        caixa.setAttribute('data-visivel', '1');
      }
      destacarLinha(achado);
    }
    window.requestAnimationFrame(quadro);
  }
  window.requestAnimationFrame(quadro);
}

function destacarLinha(indice) {
  var linhas = $('tabela-blocos').querySelectorAll('tbody tr');
  for (var i = 0; i < linhas.length; i++) {
    linhas[i].classList.toggle('ativa', i === indice);
  }
}

// ---------------------------------------------------------------------------
// Secao 8: saida
// ---------------------------------------------------------------------------

function dadosDeSaida() {
  var modo = $('modo-audio').value;
  return {
    nomeBase: nomeBase(),
    cues: estado.cues,
    aparencia: lerAparencia(),
    diagnostico: $('incluir-diagnostico').checked,
    audio: modo === 'url'
      ? { modo: 'url', url: $('url-audio').value.trim() }
      : { modo: 'embutido', bytes: estado.audioBytes, tipo: estado.audioTipo }
  };
}

function gerarSaida() {
  mostrarAviso('aviso-saida', '');
  try {
    var dados = dadosDeSaida();
    var trecho = gerarTrechoInline(dados);
    var documento = gerarDocumentoCompleto(dados);
    estado.saida = { trecho: trecho, documento: documento };

    $('saida-trecho').value = trecho.conteudo;

    var tamanho = textoParaBytes(trecho.conteudo).length;
    var partes = [
      'Trecho inline: ' + pesoLegivel(tamanho) + '.',
      'Documento completo: ' + pesoLegivel(textoParaBytes(documento.conteudo).length) + '.',
      'Saída em ASCII puro, conferida caractere a caractere.'
    ];
    if (trecho.embutido && tamanho > 3 * 1024 * 1024) {
      partes.push(
        'O trecho passou de 3 MB porque o áudio está embutido. Editores costumam ' +
        'travar com campos desse tamanho: considere publicar o MP3 no S3 (seção 9) ' +
        'e trocar a origem do áudio para URL externa.'
      );
    }
    $('info-saida').textContent = partes.join(' ');

    if (trecho.aviso) mostrarAviso('aviso-saida', trecho.aviso, 'alerta');
    atualizarBotoesDeSaida();
    notificar('Saída gerada.', 'ok');
  } catch (erro) {
    estado.saida = null;
    mostrarAviso('aviso-saida', mensagemDeErro(erro), 'erro');
    notificar(mensagemDeErro(erro), 'erro');
    atualizarBotoesDeSaida();
  }
}

function atualizarBotoesDeSaida() {
  var temCues = estado.cues.length > 0;
  var temAudio = !!(estado.audioBytes && estado.audioBytes.length);
  var temSaida = !!estado.saida;

  $('btn-copiar').disabled = !temSaida;
  $('btn-baixar-doc').disabled = !temSaida;
  $('btn-baixar-par').disabled = !temSaida || !temAudio;
  $('btn-baixar-zip').disabled = !temSaida;
  $('btn-baixar-srt').disabled = !temCues;
  $('btn-baixar-vtt').disabled = !temCues;
  $('btn-baixar-mp3').disabled = !temAudio;
}

function baixar(nome, conteudo, tipo) {
  var blob = conteudo instanceof Uint8Array
    ? new Blob([conteudo], { type: tipo })
    : new Blob([conteudo], { type: tipo + ';charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

/**
 * HTML e MP3 saem sempre juntos. Baixar so um dos dois e a receita para o par
 * ficar descasado -- HTML novo apontando para audio velho, ou o contrario.
 */
function baixarPar() {
  var nome = nomeBase();
  baixar(nome + '.html', estado.saida.documento.conteudo, 'text/html');
  window.setTimeout(function () {
    baixar(nome + '.mp3', estado.audioBytes, estado.audioTipo);
  }, 400);
  notificar('HTML e MP3 baixados juntos, com o mesmo nome-base.', 'ok');
}

function baixarZip() {
  var nome = nomeBase();
  var arquivos = [
    { nome: nome + '.html', conteudo: estado.saida.documento.conteudo },
    { nome: nome + '-trecho-inline.html', conteudo: estado.saida.trecho.conteudo },
    { nome: nome + '.srt', conteudo: paraSrt(estado.cues) },
    { nome: nome + '.vtt', conteudo: paraVtt(estado.cues) }
  ];
  if (estado.audioBytes) {
    arquivos.push({ nome: nome + '.mp3', conteudo: estado.audioBytes });
  }
  baixar(nome + '.zip', montarZip(arquivos), 'application/zip');
}

async function copiarTrecho() {
  var texto = $('saida-trecho').value;
  if (!texto) return;
  try {
    await navigator.clipboard.writeText(texto);
    notificar('Trecho copiado. Cole num elemento de HTML do Genially.', 'ok');
  } catch (erro) {
    // Sem permissão de área de transferência: seleciona para o Ctrl+C manual.
    var campo = $('saida-trecho');
    campo.focus();
    campo.select();
    notificar('O navegador bloqueou a cópia automática. O trecho já está selecionado: use Ctrl+C.', 'erro');
  }
}

async function testarUrl() {
  var botao = $('btn-testar-url');
  ocupado(botao, true, 'Testando...');
  mostrarAviso('resultado-url', '');
  try {
    var resultado = await testarUrlDeAudio($('url-audio').value.trim());
    mostrarAviso('resultado-url', resultado.mensagem, resultado.ok ? 'ok' : 'erro');
  } finally {
    ocupado(botao, false);
  }
}

// ---------------------------------------------------------------------------
// Secao 9: S3
// ---------------------------------------------------------------------------

async function enviarS3(quais) {
  var botao = quais === 'audio' ? $('btn-enviar-audio')
    : quais === 'html' ? $('btn-enviar-html') : $('btn-enviar-tudo');

  mostrarAviso('estado-s3', '');
  ocupado(botao, true, 'Enviando...');
  try {
    var cfg = lerConfigS3();
    var nome = nomeBase();
    var envios = [];

    if (quais === 'audio' || quais === 'tudo') {
      if (!estado.audioBytes) throw new ErroS3('Não há áudio para enviar. Gere ou importe o áudio antes.');
      envios.push({ nome: nome + '.mp3', conteudo: estado.audioBytes, tipo: estado.audioTipo });
    }
    if (quais === 'html' || quais === 'tudo') {
      if (!estado.saida) throw new ErroS3('Gere a saída na seção 8 antes de enviar o HTML.');
      envios.push({
        nome: nome + '.html',
        conteudo: textoParaBytes(estado.saida.documento.conteudo),
        tipo: 'text/html; charset=utf-8'
      });
    }
    if (quais === 'tudo') {
      envios.push({ nome: nome + '.srt', conteudo: textoParaBytes(paraSrt(estado.cues)), tipo: 'text/plain; charset=utf-8' });
      envios.push({ nome: nome + '.vtt', conteudo: textoParaBytes(paraVtt(estado.cues)), tipo: 'text/vtt; charset=utf-8' });
    }

    var linhas = [];
    var linkAudio = '';
    for (var i = 0; i < envios.length; i++) {
      var envio = envios[i];
      var chave = montarChave(cfg.prefixo, envio.nome);
      var resultado = await enviarParaS3(cfg, chave, envio.conteudo, envio.tipo);
      linhas.push(envio.nome + ' -> ' + resultado.url);
      if (/\.mp3$/.test(envio.nome)) linkAudio = resultado.url;
      if (!linkAudio && /\.html$/.test(envio.nome)) estado.linkS3 = resultado.url;
    }

    estado.linkS3 = linkAudio || estado.linkS3 || '';
    $('s3-link').value = estado.linkS3;
    $('btn-copiar-link').disabled = !estado.linkS3;
    $('btn-usar-link').disabled = !linkAudio;

    mostrarAviso(
      'estado-s3',
      'Envio concluído com Cache-Control: no-store.\n' + linhas.join('\n'),
      'ok'
    );
    notificar('Envio para o S3 concluído.', 'ok');
    salvarPreferencias();
  } catch (erro) {
    mostrarAviso('estado-s3', mensagemDeErro(erro), 'erro');
    notificar(mensagemDeErro(erro), 'erro');
  } finally {
    ocupado(botao, false);
  }
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

function lerPreferencias() {
  try {
    return JSON.parse(window.localStorage.getItem(CHAVE_PREFS) || '{}') || {};
  } catch (e) { return {}; }
}

function salvarPreferencias() {
  var prefs = {
    vozId: $('voz').value,
    modeloId: $('modelo').value,
    nomeBase: $('nome-base').value,
    velocidade: $('velocidade').value,
    regras: lerRegras(),
    aparencia: lerAparencia(),
    regrasDicionario: estado.regrasDicionario,
    dicionarioNome: $('dicionario-nome').value,
    diagnostico: $('incluir-diagnostico').checked,
    modoAudio: $('modo-audio').value,
    s3: {
      bucket: $('s3-bucket').value,
      regiao: $('s3-regiao').value,
      prefixo: $('s3-prefixo').value,
      publico: $('s3-publico').checked
    },
    lembrar: $('lembrar-credenciais').checked
  };
  try { window.localStorage.setItem(CHAVE_PREFS, JSON.stringify(prefs)); } catch (e) { /* cota cheia */ }

  // Segredos so vao para o disco com consentimento explicito.
  try {
    if ($('lembrar-credenciais').checked) {
      window.localStorage.setItem(CHAVE_SEGREDOS, JSON.stringify({
        chaveApi: $('chave-api').value,
        s3Chave: $('s3-chave').value,
        s3Segredo: $('s3-segredo').value,
        s3Token: $('s3-token').value
      }));
    } else {
      window.localStorage.removeItem(CHAVE_SEGREDOS);
    }
  } catch (e) { /* ignora */ }
}

function restaurarPreferencias() {
  var p = lerPreferencias();

  if (p.nomeBase) $('nome-base').value = p.nomeBase;
  if (p.velocidade) $('velocidade').value = p.velocidade;
  if (p.dicionarioNome) $('dicionario-nome').value = p.dicionarioNome;
  if (p.modoAudio) $('modo-audio').value = p.modoAudio;
  $('incluir-diagnostico').checked = !!p.diagnostico;
  $('lembrar-credenciais').checked = !!p.lembrar;

  var r = p.regras || {};
  if (r.maxCaracteresPorLinha) $('max-caracteres').value = r.maxCaracteresPorLinha;
  if (r.maxLinhas) $('max-linhas').value = r.maxLinhas;
  if (r.pausaMinima != null) $('pausa-minima').value = r.pausaMinima;
  if (r.quebrarEmFimDeFrase != null) $('quebrar-frase').checked = r.quebrarEmFimDeFrase;

  var a = p.aparencia || {};
  if (a.fonte) $('ap-fonte').value = a.fonte;
  if (a.tamanho) $('ap-tamanho').value = a.tamanho;
  if (a.peso) $('ap-peso').value = a.peso;
  if (a.corTexto) $('ap-cor-texto').value = a.corTexto;
  if (a.corTarja) $('ap-cor-tarja').value = a.corTarja;
  if (a.opacidadeTarja != null) $('ap-opacidade').value = Math.round(a.opacidadeTarja * 100);
  if (a.mostrarTarja != null) $('ap-mostrar-tarja').checked = a.mostrarTarja;
  if (a.contorno != null) $('ap-contorno').checked = a.contorno;
  if (a.posicaoVertical) $('ap-posicao').value = a.posicaoVertical;
  if (a.distanciaBorda != null) $('ap-distancia').value = a.distanciaBorda;
  if (a.alinhamentoHorizontal) $('ap-alinhamento').value = a.alinhamentoHorizontal;
  if (a.recuoHorizontal != null) $('ap-recuo-h').value = a.recuoHorizontal;
  if (a.recuoVertical != null) $('ap-recuo-v').value = a.recuoVertical;
  if (a.raioBorda != null) $('ap-raio').value = a.raioBorda;
  if (a.espacamentoLinha != null) $('ap-entrelinha').value = a.espacamentoLinha;
  if (a.larguraMaxima != null) $('ap-largura').value = a.larguraMaxima;
  if (a.ancoragem) $('ap-ancoragem').value = a.ancoragem;

  var s = p.s3 || {};
  if (s.bucket) $('s3-bucket').value = s.bucket;
  if (s.regiao) $('s3-regiao').value = s.regiao;
  if (s.prefixo) $('s3-prefixo').value = s.prefixo;
  $('s3-publico').checked = !!s.publico;

  estado.regrasDicionario = Array.isArray(p.regrasDicionario) ? p.regrasDicionario : [];

  if (p.lembrar) {
    try {
      var seg = JSON.parse(window.localStorage.getItem(CHAVE_SEGREDOS) || '{}');
      if (seg.chaveApi) $('chave-api').value = seg.chaveApi;
      if (seg.s3Chave) $('s3-chave').value = seg.s3Chave;
      if (seg.s3Segredo) $('s3-segredo').value = seg.s3Segredo;
      if (seg.s3Token) $('s3-token').value = seg.s3Token;
    } catch (e) { /* ignora */ }
  }
}

// ---------------------------------------------------------------------------
// Inicializacao
// ---------------------------------------------------------------------------

function preencherFontes() {
  var sel = $('ap-fonte');
  FONTES.forEach(function (f) {
    var op = document.createElement('option');
    op.value = f.valor;
    op.textContent = f.rotulo;
    sel.appendChild(op);
  });
  sel.value = APARENCIA_PADRAO.fonte;
}

function atualizarPreviaDeNomes() {
  var n = nomeBase();
  $('previa-nomes').textContent =
    n + '.html / ' + n + '.mp3 / ' + n + '.srt / ' + n + '.vtt / ' + n + '.zip';
}

function trocarOrigem(origem) {
  estado.origem = origem;
  todos('.aba').forEach(function (b) {
    b.classList.toggle('ativa', b.dataset.origem === origem);
  });
  todos('.painel-origem').forEach(function (p) {
    p.classList.toggle('oculto', p.dataset.painel !== origem);
  });
}

function ligarEventos() {
  $('btn-conectar').addEventListener('click', conectar);
  $('btn-mostrar-chave').addEventListener('click', function () {
    var campo = $('chave-api');
    var oculto = campo.type === 'password';
    campo.type = oculto ? 'text' : 'password';
    this.textContent = oculto ? 'Ocultar' : 'Mostrar';
  });

  $('voz').addEventListener('change', function () {
    $('voz-id').value = this.value;
    salvarPreferencias();
  });
  $('modelo').addEventListener('change', function () {
    atualizarNotaModelo();
    salvarPreferencias();
  });

  // Campos de credencial: limpa caracteres invisiveis assim que sao colados.
  ['chave-api', 's3-chave', 's3-segredo', 's3-token'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var limpo = limparInvisiveis(this.value);
      if (limpo !== this.value) {
        this.value = limpo;
        notificar('Caracteres invisíveis foram removidos do campo colado.', 'ok');
      }
      if (id === 'chave-api') estado.cliente = null;
      salvarPreferencias();
    });
  });

  $('nome-base').addEventListener('input', atualizarPreviaDeNomes);
  $('nome-base').addEventListener('change', function () {
    this.value = nomeBase();
    atualizarPreviaDeNomes();
    salvarPreferencias();
  });

  $('texto').addEventListener('input', function () {
    $('contagem-texto').textContent = this.value.length + ' caracteres';
  });

  todos('.aba').forEach(function (b) {
    b.addEventListener('click', function () { trocarOrigem(this.dataset.origem); });
  });

  $('btn-gerar').addEventListener('click', gerarComTimestamps);
  $('btn-importar').addEventListener('click', importarArquivos);
  $('btn-transcrever').addEventListener('click', transcrever);

  $('regra-tipo').addEventListener('change', function () {
    var fonema = this.value === 'fonema';
    $('rotulo-regra-valor').textContent = fonema ? 'Transcrição em IPA' : 'Como deve ser lido';
    $('regra-valor').placeholder = fonema ? 'kaɾdioloʒiɐ' : 'infarto agudo do miocárdio';
  });
  $('btn-add-regra').addEventListener('click', adicionarRegra);
  $('regra-valor').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') adicionarRegra();
  });
  $('btn-salvar-dicionario').addEventListener('click', salvarDicionario);

  $('btn-reaplicar').addEventListener('click', reaplicarRegras);
  ['max-caracteres', 'max-linhas', 'pausa-minima', 'quebrar-frase'].forEach(function (id) {
    $(id).addEventListener('change', salvarPreferencias);
  });

  // Aparencia: qualquer mudanca redesenha a previa na hora.
  todos('#sec-aparencia input, #sec-aparencia select').forEach(function (campo) {
    campo.addEventListener('input', function () {
      $('ap-opacidade-valor').textContent = $('ap-opacidade').value;
      atualizarPrevia();
    });
    campo.addEventListener('change', salvarPreferencias);
  });

  $('modo-audio').addEventListener('change', function () {
    var externo = this.value === 'url';
    $('url-audio').disabled = !externo;
    $('btn-testar-url').disabled = !externo;
    salvarPreferencias();
  });
  $('btn-testar-url').addEventListener('click', testarUrl);
  $('incluir-diagnostico').addEventListener('change', salvarPreferencias);

  $('btn-gerar-saida').addEventListener('click', gerarSaida);
  $('btn-copiar').addEventListener('click', copiarTrecho);
  $('btn-baixar-par').addEventListener('click', baixarPar);
  $('btn-baixar-zip').addEventListener('click', baixarZip);
  $('btn-baixar-doc').addEventListener('click', function () {
    baixar(nomeBase() + '.html', estado.saida.documento.conteudo, 'text/html');
  });
  $('btn-baixar-srt').addEventListener('click', function () {
    baixar(nomeBase() + '.srt', paraSrt(estado.cues), 'text/plain');
  });
  $('btn-baixar-vtt').addEventListener('click', function () {
    baixar(nomeBase() + '.vtt', paraVtt(estado.cues), 'text/vtt');
  });
  $('btn-baixar-mp3').addEventListener('click', function () {
    baixar(nomeBase() + '.mp3', estado.audioBytes, estado.audioTipo);
  });

  $('btn-enviar-audio').addEventListener('click', function () { enviarS3('audio'); });
  $('btn-enviar-html').addEventListener('click', function () { enviarS3('html'); });
  $('btn-enviar-tudo').addEventListener('click', function () { enviarS3('tudo'); });
  ['s3-bucket', 's3-regiao', 's3-prefixo', 's3-publico'].forEach(function (id) {
    $(id).addEventListener('change', salvarPreferencias);
  });
  $('lembrar-credenciais').addEventListener('change', salvarPreferencias);

  $('btn-copiar-link').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText($('s3-link').value);
      notificar('Link copiado.', 'ok');
    } catch (e) {
      $('s3-link').select();
      notificar('Copie manualmente com Ctrl+C.', 'erro');
    }
  });
  $('btn-usar-link').addEventListener('click', function () {
    $('url-audio').value = $('s3-link').value;
    $('modo-audio').value = 'url';
    $('url-audio').disabled = false;
    $('btn-testar-url').disabled = false;
    notificar('Origem do áudio trocada para URL externa. Gere a saída de novo.', 'ok');
  });
}

/**
 * Marca no menu lateral a secao que esta na tela. Sem isso, numa pagina
 * longa como esta, o menu vira decoracao: mostra para onde ir, mas nunca
 * onde se esta.
 */
function acompanharSecoes() {
  var links = {};
  todos('.atalhos a').forEach(function (a) {
    links[a.getAttribute('href').slice(1)] = a;
  });
  var secoes = todos('main section.cartao');
  if (!secoes.length || typeof IntersectionObserver !== 'function') return;

  var visiveis = Object.create(null);

  var observador = new IntersectionObserver(function (entradas) {
    entradas.forEach(function (e) {
      if (e.isIntersecting) visiveis[e.target.id] = e.intersectionRatio;
      else delete visiveis[e.target.id];
    });

    // A secao ativa e a primeira visivel na ordem do documento, e nao a mais
    // visivel: rolando devagar, a "mais visivel" fica trocando sozinha.
    var ativa = null;
    for (var i = 0; i < secoes.length; i++) {
      if (visiveis[secoes[i].id] !== undefined) { ativa = secoes[i].id; break; }
    }
    for (var id in links) {
      if (Object.prototype.hasOwnProperty.call(links, id)) {
        links[id].classList.toggle('ativa', id === ativa);
      }
    }
  }, { rootMargin: '-96px 0px -55% 0px', threshold: 0 });

  secoes.forEach(function (s) { observador.observe(s); });
}

function iniciar() {
  preencherFontes();
  restaurarPreferencias();
  ligarEventos();
  desenharRegras();
  atualizarPreviaDeNomes();
  atualizarPrevia();
  atualizarBotoesDeSaida();
  acompanharPrevia();
  acompanharSecoes();
  $('ap-opacidade-valor').textContent = $('ap-opacidade').value;
  $('contagem-texto').textContent = $('texto').value.length + ' caracteres';
  $('url-audio').disabled = $('modo-audio').value !== 'url';
  $('btn-testar-url').disabled = $('modo-audio').value !== 'url';
  $('blocos-vazio').classList.remove('oculto');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciar);
} else {
  iniciar();
}
