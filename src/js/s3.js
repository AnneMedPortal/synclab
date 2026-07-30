// Hospedagem no S3, assinada no proprio navegador (AWS Signature V4).
//
// Nao ha backend: o navegador assina e faz o PUT direto no bucket. Isso exige
// duas configuracoes do lado da AWS, e as duas aparecem nas mensagens de erro
// deste modulo, porque sao a causa de praticamente todas as falhas:
//
//   1. CORS no bucket liberando PUT e o cabecalho Authorization para a origem
//      de onde o SyncLab e aberto;
//   2. uma credencial cuja politica permita s3:PutObject naquele prefixo.
//
// Os objetos vao com Cache-Control: no-store, para que republicar um audio
// apareca atualizado na hora -- sem isso, o aluno continua ouvindo a versao
// antiga em cache mesmo depois da correcao.

import { limparInvisiveis, bytesParaHex, textoParaBytes } from './util.js';

export var CACHE_CONTROL_PADRAO = 'no-store, no-cache, must-revalidate, max-age=0';

export class ErroS3 extends Error {
  constructor(mensagem, detalhes) {
    super(mensagem);
    this.name = 'ErroS3';
    this.status = detalhes && detalhes.status;
    this.codigoAws = detalhes && detalhes.codigoAws;
    this.corpo = detalhes && detalhes.corpo;
  }
}

function subtle() {
  var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (!c || !c.subtle) {
    throw new ErroS3(
      'O navegador nao expos a API de criptografia necessaria para assinar o envio. ' +
      'Isso acontece quando a pagina e aberta por http:// ou por arquivo local. ' +
      'Abra o SyncLab por https:// ou por http://localhost.'
    );
  }
  return c.subtle;
}

async function sha256(bytes) {
  var digest = await subtle().digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

async function hmac(chave, mensagem) {
  var k = await subtle().importKey(
    'raw',
    chave,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  var assinatura = await subtle().sign('HMAC', k, mensagem);
  return new Uint8Array(assinatura);
}

export async function sha256Hex(bytes) {
  return bytesParaHex(await sha256(bytes));
}

/** Escape RFC 3986: encodeURIComponent nao cobre !'()* */
export function escaparUri(texto) {
  return encodeURIComponent(String(texto)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/** Escapa a chave do objeto preservando as barras da "pasta". */
export function escaparCaminho(caminho) {
  return String(caminho)
    .split('/')
    .map(escaparUri)
    .join('/');
}

/** Date -> { amzDate: 'YYYYMMDDTHHMMSSZ', dia: 'YYYYMMDD' } */
export function carimboDeData(data) {
  var d = data || new Date();
  var iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dia: iso.slice(0, 8) };
}

/**
 * Assina uma requisicao S3 com SigV4.
 *
 * Assina exatamente os cabecalhos recebidos em `cabecalhos` (incluindo host),
 * o que mantem a funcao verificavel contra os vetores de teste publicados pela
 * AWS -- ha um deles na suite de testes deste projeto.
 *
 * @returns {Promise<{authorization: string, cabecalhosAssinados: object, requisicaoCanonica: string, stringParaAssinar: string}>}
 */
export async function assinarRequisicao(opcoes) {
  var metodo = opcoes.metodo || 'PUT';
  var caminho = opcoes.caminho || '/';
  var consulta = opcoes.consulta || '';
  var regiao = opcoes.regiao;
  var servico = opcoes.servico || 's3';
  var cabecalhos = opcoes.cabecalhos || {};
  var hashCorpo = opcoes.hashCorpo;
  var carimbo = opcoes.carimbo || carimboDeData(opcoes.data);

  // Cabecalhos canonicos: nome em minusculo, valor com espacos colapsados,
  // ordenados por nome.
  var nomes = Object.keys(cabecalhos).map(function (n) {
    return n.toLowerCase();
  }).sort();

  var mapa = {};
  Object.keys(cabecalhos).forEach(function (n) {
    mapa[n.toLowerCase()] = String(cabecalhos[n]).replace(/\s+/g, ' ').trim();
  });

  var canonicos = nomes.map(function (n) {
    return n + ':' + mapa[n] + '\n';
  }).join('');
  var listaAssinada = nomes.join(';');

  var requisicaoCanonica = [
    metodo,
    caminho,
    consulta,
    canonicos,
    listaAssinada,
    hashCorpo
  ].join('\n');

  var escopo = carimbo.dia + '/' + regiao + '/' + servico + '/aws4_request';
  var stringParaAssinar = [
    'AWS4-HMAC-SHA256',
    carimbo.amzDate,
    escopo,
    await sha256Hex(textoParaBytes(requisicaoCanonica))
  ].join('\n');

  var kData = await hmac(textoParaBytes('AWS4' + opcoes.segredo), textoParaBytes(carimbo.dia));
  var kRegiao = await hmac(kData, textoParaBytes(regiao));
  var kServico = await hmac(kRegiao, textoParaBytes(servico));
  var kAssinatura = await hmac(kServico, textoParaBytes('aws4_request'));
  var assinatura = bytesParaHex(await hmac(kAssinatura, textoParaBytes(stringParaAssinar)));

  var authorization =
    'AWS4-HMAC-SHA256 Credential=' + opcoes.chaveAcesso + '/' + escopo +
    ', SignedHeaders=' + listaAssinada +
    ', Signature=' + assinatura;

  return {
    authorization: authorization,
    assinatura: assinatura,
    listaAssinada: listaAssinada,
    requisicaoCanonica: requisicaoCanonica,
    stringParaAssinar: stringParaAssinar,
    carimbo: carimbo
  };
}

/** Monta o endereco do bucket no estilo virtual-hosted. */
export function hostDoBucket(bucket, regiao, endpointPersonalizado) {
  if (endpointPersonalizado) {
    return String(endpointPersonalizado).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }
  if (regiao === 'us-east-1') return bucket + '.s3.amazonaws.com';
  return bucket + '.s3.' + regiao + '.amazonaws.com';
}

/** URL publica final, pronta para colar. */
export function montarUrlPublica(config, chaveObjeto) {
  return 'https://' + hostDoBucket(config.bucket, config.regiao, config.endpoint) +
    '/' + escaparCaminho(chaveObjeto);
}

/** Junta prefixo de pasta e nome do arquivo sem barras duplicadas. */
export function montarChave(prefixo, nomeArquivo) {
  var p = String(prefixo || '').replace(/^\/+|\/+$/g, '');
  return p ? p + '/' + nomeArquivo : nomeArquivo;
}

/**
 * Envia um objeto para o S3.
 *
 * @param {object} config  { bucket, regiao, chaveAcesso, segredo, token?, prefixo?, endpoint?, publico? }
 * @param {string} chaveObjeto  caminho dentro do bucket
 * @param {Uint8Array|Blob} conteudo
 * @param {string} tipoConteudo
 */
export async function enviarParaS3(config, chaveObjeto, conteudo, tipoConteudo) {
  var cfg = validarConfig(config);
  var bytes = conteudo instanceof Uint8Array
    ? conteudo
    : new Uint8Array(await conteudo.arrayBuffer());

  var host = hostDoBucket(cfg.bucket, cfg.regiao, cfg.endpoint);
  var caminho = '/' + escaparCaminho(chaveObjeto);
  var hashCorpo = await sha256Hex(bytes);
  var carimbo = carimboDeData();

  var cabecalhos = {
    host: host,
    'cache-control': CACHE_CONTROL_PADRAO,
    'content-type': tipoConteudo || 'application/octet-stream',
    'x-amz-content-sha256': hashCorpo,
    'x-amz-date': carimbo.amzDate
  };
  if (cfg.token) cabecalhos['x-amz-security-token'] = cfg.token;
  if (cfg.publico) cabecalhos['x-amz-acl'] = 'public-read';

  var assinado = await assinarRequisicao({
    metodo: 'PUT',
    caminho: caminho,
    consulta: '',
    regiao: cfg.regiao,
    servico: 's3',
    cabecalhos: cabecalhos,
    hashCorpo: hashCorpo,
    chaveAcesso: cfg.chaveAcesso,
    segredo: cfg.segredo,
    carimbo: carimbo
  });

  // O navegador define host sozinho e proibe sobrescreve-lo; ele participa da
  // assinatura, mas nao pode ir na lista de cabecalhos do fetch.
  var enviar = {};
  Object.keys(cabecalhos).forEach(function (n) {
    if (n !== 'host') enviar[n] = cabecalhos[n];
  });
  enviar.Authorization = assinado.authorization;

  var resposta;
  try {
    resposta = await fetch('https://' + host + caminho, {
      method: 'PUT',
      headers: enviar,
      body: bytes
    });
  } catch (erro) {
    throw new ErroS3(
      'O navegador nao conseguiu enviar o arquivo para o S3. Quase sempre isso e CORS: ' +
      'o bucket precisa de uma regra permitindo o metodo PUT, o cabecalho Authorization ' +
      'em AllowedHeaders e a origem de onde voce abriu o SyncLab em AllowedOrigins. ' +
      'Detalhe tecnico: ' + erro.message
    );
  }

  if (!resposta.ok) throw await traduzirErroS3(resposta);

  return {
    url: montarUrlPublica(cfg, chaveObjeto),
    chave: chaveObjeto,
    etag: resposta.headers.get('ETag') || '',
    tamanho: bytes.length
  };
}

function validarConfig(config) {
  var cfg = config || {};
  var bucket = limparInvisiveis(cfg.bucket);
  var regiao = limparInvisiveis(cfg.regiao);
  var chaveAcesso = limparInvisiveis(cfg.chaveAcesso);
  var segredo = limparInvisiveis(cfg.segredo);

  if (!bucket) throw new ErroS3('Informe o nome do bucket S3.');
  if (!regiao) throw new ErroS3('Informe a regiao do bucket (por exemplo, us-east-1 ou sa-east-1).');
  if (!chaveAcesso) throw new ErroS3('Informe o Access Key ID da AWS.');
  if (!segredo) throw new ErroS3('Informe o Secret Access Key da AWS.');
  if (!/^[a-z0-9.\-]{3,63}$/.test(bucket)) {
    throw new ErroS3(
      'Nome de bucket invalido: "' + bucket + '". O nome so aceita letras minusculas, ' +
      'numeros, ponto e hifen, com 3 a 63 caracteres.'
    );
  }

  return {
    bucket: bucket,
    regiao: regiao,
    chaveAcesso: chaveAcesso,
    segredo: segredo,
    token: limparInvisiveis(cfg.token || ''),
    endpoint: limparInvisiveis(cfg.endpoint || ''),
    prefixo: String(cfg.prefixo || '').trim(),
    publico: !!cfg.publico
  };
}

async function traduzirErroS3(resposta) {
  var corpo = '';
  try { corpo = await resposta.text(); } catch (e) { corpo = ''; }

  var codigo = '';
  var m = /<Code>([^<]+)<\/Code>/.exec(corpo);
  if (m) codigo = m[1];

  var mensagem;
  switch (codigo) {
    case 'SignatureDoesNotMatch':
      mensagem =
        'A assinatura foi recusada pela AWS. Confira o Secret Access Key (basta um caractere ' +
        'errado) e se a regiao informada e mesmo a regiao do bucket.';
      break;
    case 'InvalidAccessKeyId':
      mensagem = 'O Access Key ID nao existe nesta conta da AWS. Confira o valor copiado.';
      break;
    case 'AccessDenied':
      mensagem =
        'Acesso negado pela AWS. A credencial existe, mas nao tem permissao de s3:PutObject ' +
        'neste bucket ou neste prefixo. Ajuste a politica do usuario ou do bucket.';
      break;
    case 'NoSuchBucket':
      mensagem = 'Esse bucket nao existe na regiao informada. Confira o nome e a regiao.';
      break;
    case 'RequestTimeTooSkewed':
      mensagem =
        'O relogio deste computador esta muito diferente do relogio da AWS. ' +
        'Acerte a data e a hora do sistema e tente de novo.';
      break;
    case 'InvalidBucketName':
      mensagem = 'Nome de bucket invalido para a AWS.';
      break;
    case 'AuthorizationHeaderMalformed':
      mensagem =
        'A AWS recusou o cabecalho de autorizacao, normalmente por regiao errada. ' +
        'Verifique em qual regiao o bucket foi criado. Resposta da AWS: ' + corpo.slice(0, 300);
      break;
    default:
      mensagem =
        'O S3 respondeu com erro ' + resposta.status +
        (codigo ? ' (' + codigo + ')' : '') + '. Resposta: ' + corpo.slice(0, 300);
  }

  return new ErroS3(mensagem, { status: resposta.status, codigoAws: codigo, corpo: corpo });
}

/**
 * Testa se a URL do audio realmente carrega.
 *
 * Usa um elemento <audio>, e nao fetch, de proposito: e exatamente assim que o
 * navegador do aluno vai buscar o arquivo. Um fetch poderia falhar por CORS num
 * endereco que toca normalmente, ou passar num endereco que o player recusa.
 */
export function testarUrlDeAudio(url, tempoLimiteMs) {
  return new Promise(function (resolver) {
    var limite = tempoLimiteMs || 12000;
    var endereco = String(url || '').trim();

    if (!endereco) {
      resolver({ ok: false, mensagem: 'Nenhuma URL informada.' });
      return;
    }
    if (!/^https?:\/\//i.test(endereco)) {
      resolver({ ok: false, mensagem: 'A URL precisa comecar com http:// ou https://.' });
      return;
    }
    if (typeof Audio === 'undefined') {
      resolver({ ok: false, mensagem: 'Este ambiente nao tem player de audio para testar.' });
      return;
    }

    var audio = new Audio();
    var respondido = false;
    var inicio = Date.now();

    function terminar(resultado) {
      if (respondido) return;
      respondido = true;
      window.clearTimeout(cronometro);
      audio.src = '';
      resolver(resultado);
    }

    var cronometro = window.setTimeout(function () {
      terminar({
        ok: false,
        mensagem:
          'O audio nao respondeu em ' + Math.round(limite / 1000) + ' segundos. ' +
          'O endereco pode estar inacessivel, muito lento ou bloqueado.'
      });
    }, limite);

    audio.addEventListener('loadedmetadata', function () {
      terminar({
        ok: true,
        duracao: audio.duration,
        tempoMs: Date.now() - inicio,
        mensagem:
          'Audio acessivel. Duracao: ' +
          (isFinite(audio.duration) ? audio.duration.toFixed(2) + 's' : 'desconhecida') +
          ' (respondeu em ' + (Date.now() - inicio) + ' ms).'
      });
    });

    audio.addEventListener('error', function () {
      var err = audio.error;
      var causa = 'motivo nao informado pelo navegador';
      if (err) {
        if (err.code === 2) causa = 'falha de rede -- confira se o objeto e publico e se o bucket permite leitura';
        else if (err.code === 3) causa = 'o arquivo baixou mas nao pode ser decodificado';
        else if (err.code === 4) causa = 'endereco inacessivel ou formato nao suportado (404, 403 ou tipo errado)';
        else if (err.code === 1) causa = 'carregamento cancelado';
      }
      terminar({ ok: false, mensagem: 'O audio nao carregou: ' + causa + '.' });
    });

    audio.preload = 'metadata';
    audio.src = endereco;
    audio.load();
  });
}
