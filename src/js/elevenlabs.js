// Cliente da API da ElevenLabs.
//
// Tudo sai direto do navegador com o cabecalho xi-api-key. Nao ha servidor
// intermediario: a chave nunca sai da maquina de quem usa, e nao e gravada
// em lugar nenhum alem do armazenamento local do proprio navegador.

import { limparInvisiveis, base64ParaBytes } from './util.js';

export var BASE_URL = 'https://api.elevenlabs.io/v1';

/** Modelos recomendados, com a indicacao de uso que a especificacao pede. */
export var MODELOS_SUGERIDOS = [
  {
    id: 'eleven_multilingual_v2',
    nome: 'Multilingual v2',
    nota: 'Melhor qualidade em PT-BR. Recomendado para narracao de aula.'
  },
  {
    id: 'eleven_turbo_v2_5',
    nome: 'Turbo v2.5',
    nota: 'Mais rapido e mais barato, com boa qualidade em portugues.'
  },
  {
    id: 'eleven_flash_v2_5',
    nome: 'Flash v2.5',
    nota: 'O mais rapido. Use para rascunho e testes de sincronia.'
  }
];

export var FORMATO_PADRAO = 'mp3_44100_128';

/** Erro com mensagem ja traduzida para portugues. */
export class ErroElevenLabs extends Error {
  constructor(mensagem, detalhes) {
    super(mensagem);
    this.name = 'ErroElevenLabs';
    this.status = detalhes && detalhes.status;
    this.codigo = detalhes && detalhes.codigo;
    this.corpo = detalhes && detalhes.corpo;
  }
}

export class ClienteElevenLabs {
  /**
   * @param {string} chave chave de API (xi-api-key)
   * @param {{baseUrl?: string, fetch?: Function}} [opcoes]
   */
  constructor(chave, opcoes) {
    var cfg = opcoes || {};
    this.chave = limparInvisiveis(chave);
    this.baseUrl = cfg.baseUrl || BASE_URL;
    this.fetch = cfg.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!this.chave) {
      throw new ErroElevenLabs('Informe a chave de API da ElevenLabs antes de continuar.');
    }
    if (!this.fetch) {
      throw new ErroElevenLabs('Este ambiente nao tem fetch disponivel.');
    }
  }

  cabecalhos(extras) {
    var h = { 'xi-api-key': this.chave };
    if (extras) {
      for (var k in extras) {
        if (Object.prototype.hasOwnProperty.call(extras, k)) h[k] = extras[k];
      }
    }
    return h;
  }

  async requisitar(caminho, opcoes) {
    var cfg = opcoes || {};
    var resposta;
    try {
      resposta = await this.fetch(this.baseUrl + caminho, {
        method: cfg.method || 'GET',
        headers: this.cabecalhos(cfg.headers),
        body: cfg.body
      });
    } catch (erro) {
      throw new ErroElevenLabs(
        'Nao foi possivel falar com a ElevenLabs. Verifique a conexao com a internet ' +
        'e se alguma extensao do navegador esta bloqueando a chamada. Detalhe: ' + erro.message
      );
    }
    if (!resposta.ok) throw await traduzirErro(resposta);
    return resposta;
  }

  // -------------------------------------------------------------------------
  // Vozes e modelos
  // -------------------------------------------------------------------------

  /** Vozes da conta, para escolher o Voice ID. */
  async listarVozes() {
    var resposta = await this.requisitar('/voices');
    var dados = await resposta.json();
    return (dados.voices || []).map(function (v) {
      return {
        id: v.voice_id,
        nome: v.name || v.voice_id,
        categoria: v.category || '',
        descricao: (v.labels && (v.labels.description || v.labels.accent)) || '',
        previa: v.preview_url || ''
      };
    });
  }

  /** Modelos disponiveis para a conta, cruzados com as sugestoes locais. */
  async listarModelos() {
    var resposta = await this.requisitar('/models');
    var dados = await resposta.json();
    var lista = (Array.isArray(dados) ? dados : dados.models || []).map(function (m) {
      return {
        id: m.model_id,
        nome: m.name || m.model_id,
        idiomas: (m.languages || []).map(function (l) { return l.language_id; }),
        suportaTts: m.can_do_text_to_speech !== false,
        nota: ''
      };
    });
    for (var i = 0; i < lista.length; i++) {
      for (var j = 0; j < MODELOS_SUGERIDOS.length; j++) {
        if (lista[i].id === MODELOS_SUGERIDOS[j].id) lista[i].nota = MODELOS_SUGERIDOS[j].nota;
      }
    }
    return lista.filter(function (m) { return m.suportaTts; });
  }

  // -------------------------------------------------------------------------
  // Geracao de audio
  // -------------------------------------------------------------------------

  corpoTts(opcoes) {
    var corpo = {
      text: String(opcoes.texto || ''),
      model_id: opcoes.modelo || 'eleven_multilingual_v2'
    };
    var ajustes = {};
    if (opcoes.estabilidade != null) ajustes.stability = Number(opcoes.estabilidade);
    if (opcoes.similaridade != null) ajustes.similarity_boost = Number(opcoes.similaridade);
    if (opcoes.estilo != null) ajustes.style = Number(opcoes.estilo);
    if (opcoes.reforcoDeAltoFalante != null) ajustes.use_speaker_boost = !!opcoes.reforcoDeAltoFalante;
    if (Object.keys(ajustes).length) corpo.voice_settings = ajustes;

    if (opcoes.velocidade != null && Number(opcoes.velocidade) !== 1) {
      corpo.voice_settings = corpo.voice_settings || {};
      corpo.voice_settings.speed = Number(opcoes.velocidade);
    }
    if (opcoes.dicionarios && opcoes.dicionarios.length) {
      corpo.pronunciation_dictionary_locators = opcoes.dicionarios.map(function (d) {
        return { pronunciation_dictionary_id: d.id, version_id: d.versao };
      });
    }
    if (opcoes.semente != null) corpo.seed = Number(opcoes.semente);
    return corpo;
  }

  /** Gera somente o audio. Devolve os bytes do MP3. */
  async gerarAudio(opcoes) {
    var formato = opcoes.formato || FORMATO_PADRAO;
    var resposta = await this.requisitar(
      '/text-to-speech/' + encodeURIComponent(opcoes.vozId) + '?output_format=' + encodeURIComponent(formato),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify(this.corpoTts(opcoes))
      }
    );
    var buffer = await resposta.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * Gera audio e alinhamento de uma vez. E o caminho que a especificacao
   * chama de "sincronia perfeita, sem transcricao": a propria sintese informa
   * o instante de cada caractere falado.
   *
   * Usamos normalized_alignment quando existe, porque ele corresponde ao texto
   * como foi de fato pronunciado (numeros e siglas ja expandidos).
   */
  async gerarAudioComTimestamps(opcoes) {
    var formato = opcoes.formato || FORMATO_PADRAO;
    var resposta = await this.requisitar(
      '/text-to-speech/' + encodeURIComponent(opcoes.vozId) +
        '/with-timestamps?output_format=' + encodeURIComponent(formato),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(this.corpoTts(opcoes))
      }
    );
    var dados = await resposta.json();
    if (!dados || !dados.audio_base64) {
      throw new ErroElevenLabs(
        'A ElevenLabs respondeu sem o audio. Tente novamente; se persistir, ' +
        'gere o audio sozinho e transcreva pelo Scribe.'
      );
    }
    return {
      audio: base64ParaBytes(dados.audio_base64),
      alinhamento: dados.normalized_alignment || dados.alignment || null,
      alinhamentoBruto: dados.alignment || null
    };
  }

  // -------------------------------------------------------------------------
  // Transcricao (Scribe)
  // -------------------------------------------------------------------------

  /**
   * Transcreve um audio ja existente, com timestamp por palavra.
   * @param {Blob|File} arquivo
   */
  async transcrever(arquivo, opcoes) {
    var cfg = opcoes || {};
    var forma = new FormData();
    forma.append('file', arquivo, cfg.nomeArquivo || 'audio.mp3');
    forma.append('model_id', cfg.modelo || 'scribe_v1');
    forma.append('timestamps_granularity', 'word');
    forma.append('diarize', 'false');
    if (cfg.idioma) forma.append('language_code', cfg.idioma);

    var resposta = await this.requisitar('/speech-to-text', { method: 'POST', body: forma });
    return await resposta.json();
  }

  // -------------------------------------------------------------------------
  // Dicionario de pronuncia
  // -------------------------------------------------------------------------

  async listarDicionarios() {
    var resposta = await this.requisitar('/pronunciation-dictionaries?page_size=100');
    var dados = await resposta.json();
    return (dados.pronunciation_dictionaries || []).map(function (d) {
      return {
        id: d.id,
        nome: d.name,
        versao: d.latest_version_id || d.version_id,
        contagem: d.latest_version_rules_num != null ? d.latest_version_rules_num : null
      };
    });
  }

  /**
   * Cria um dicionario com as regras informadas. Devolve id + version_id, que
   * sao os dois valores necessarios para aplicar o dicionario nas geracoes.
   */
  async criarDicionario(nome, regras) {
    var resposta = await this.requisitar('/pronunciation-dictionaries/add-from-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: String(nome || 'synclab'),
        description: 'Criado pelo SyncLab',
        rules: regrasParaApi(regras)
      })
    });
    var dados = await resposta.json();
    return { id: dados.id, versao: dados.version_id, nome: dados.name };
  }

  /** Acrescenta regras a um dicionario existente; devolve a nova versao. */
  async adicionarRegras(dicionarioId, regras) {
    var resposta = await this.requisitar(
      '/pronunciation-dictionaries/' + encodeURIComponent(dicionarioId) + '/add-rules',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: regrasParaApi(regras) })
      }
    );
    var dados = await resposta.json();
    return { id: dados.id || dicionarioId, versao: dados.version_id };
  }

  /** Informacoes da assinatura, uteis para mostrar creditos restantes. */
  async assinatura() {
    var resposta = await this.requisitar('/user/subscription');
    var dados = await resposta.json();
    return {
      plano: dados.tier || '',
      usados: dados.character_count,
      limite: dados.character_limit
    };
  }
}

/**
 * Converte as regras do formato interno do SyncLab para o formato da API.
 *
 * - substituicao: troca a grafia antes da sintese ("IAM" -> "infarto agudo do miocardio")
 * - fonema: forca a pronuncia em IPA (so vale em alguns modelos)
 */
export function regrasParaApi(regras) {
  return (regras || [])
    .filter(function (r) {
      return r && limparInvisiveis(r.termo);
    })
    .map(function (r) {
      var termo = limparInvisiveis(r.termo);
      if (r.tipo === 'fonema') {
        return {
          string_to_replace: termo,
          type: 'phoneme',
          phoneme: limparInvisiveis(r.valor),
          alphabet: r.alfabeto || 'ipa'
        };
      }
      return {
        string_to_replace: termo,
        type: 'alias',
        alias: limparInvisiveis(r.valor)
      };
    });
}

/** Valida uma regra antes de mandar para a API, com mensagem em portugues. */
export function validarRegra(regra) {
  var termo = limparInvisiveis(regra && regra.termo);
  var valor = limparInvisiveis(regra && regra.valor);
  if (!termo) return 'Informe o termo que a voz esta errando.';
  if (!valor) {
    return regra.tipo === 'fonema'
      ? 'Informe a transcricao em IPA para esse termo.'
      : 'Informe como o termo deve ser escrito para a voz ler certo.';
  }
  if (regra.tipo === 'fonema' && /^[A-Za-z ]+$/.test(valor) && valor.length > 3) {
    return 'Isso parece uma grafia comum, nao IPA. Para trocar a escrita, use o tipo "substituicao".';
  }
  return null;
}

/**
 * Traduz o erro da API para uma mensagem em portugues que diz o que fazer.
 * A especificacao trata isso como requisito, nao como enfeite.
 */
async function traduzirErro(resposta) {
  var corpo = null;
  var texto = '';
  try {
    texto = await resposta.text();
    corpo = JSON.parse(texto);
  } catch (e) {
    corpo = null;
  }

  var detalhe = corpo && corpo.detail;
  var codigo = (detalhe && (detalhe.status || detalhe.code)) || '';
  var mensagemApi = (detalhe && (detalhe.message || detalhe.detail)) ||
    (typeof detalhe === 'string' ? detalhe : '') ||
    (corpo && corpo.message) || '';

  var mensagem;
  switch (codigo) {
    case 'invalid_api_key':
    case 'needs_authorization':
      mensagem =
        'Chave de API recusada. Confira se copiou a chave inteira, sem espacos, ' +
        'em Perfil > API Keys no painel da ElevenLabs.';
      break;
    case 'missing_permissions':
    case 'pronunciation_dictionary_permission_missing':
      mensagem =
        'A chave de API nao tem permissao de escrita de dicionario. No painel da ' +
        'ElevenLabs, edite a chave e habilite a permissao de Pronunciation Dictionaries ' +
        '(leitura e escrita). Depois cole a chave aqui de novo.';
      break;
    case 'quota_exceeded':
      mensagem =
        'Os creditos de caracteres da conta acabaram. Reduza o texto da narracao ' +
        'ou aguarde a renovacao do plano.';
      break;
    case 'voice_not_found':
      mensagem = 'Voz nao encontrada. Recarregue a lista de vozes e escolha de novo.';
      break;
    case 'model_not_found':
      mensagem = 'Modelo nao encontrado ou indisponivel para esta conta. Escolha outro modelo.';
      break;
    case 'invalid_uid':
      mensagem = 'Identificador invalido. Recarregue a lista e tente novamente.';
      break;
    default:
      mensagem = '';
  }

  if (!mensagem) {
    switch (resposta.status) {
      case 401:
      case 403:
        mensagem =
          'Acesso negado pela ElevenLabs (' + resposta.status + '). Verifique a chave de API ' +
          'e as permissoes habilitadas para ela.';
        break;
      case 404:
        mensagem = 'Recurso nao encontrado na ElevenLabs (404). Confira a voz ou o dicionario escolhido.';
        break;
      case 422:
        mensagem =
          'A ElevenLabs recusou os dados enviados (422). Costuma ser texto vazio, ' +
          'voz nao selecionada ou regra de dicionario mal formada.';
        break;
      case 429:
        mensagem =
          'Muitas requisicoes seguidas (429). Espere alguns segundos e tente de novo.';
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        mensagem =
          'A ElevenLabs esta instavel no momento (' + resposta.status + '). Tente novamente em instantes.';
        break;
      default:
        mensagem = 'A ElevenLabs respondeu com erro ' + resposta.status + '.';
    }
  }

  if (mensagemApi) mensagem += ' [resposta da API: ' + mensagemApi + ']';

  return new ErroElevenLabs(mensagem, {
    status: resposta.status,
    codigo: codigo,
    corpo: corpo || texto
  });
}
