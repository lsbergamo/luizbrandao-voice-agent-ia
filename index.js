import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";
import https from "https";

// Load environment variables from .env file
dotenv.config();
// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error("Missing OpenAI API key. Please set it in the .env file.");
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Função para obter a data formatada em português com fuso horário de São Paulo
function obterDataFormatada() {
    const hoje = new Date();
    const opções = {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "America/Sao_Paulo", // Define o fuso horário para São Paulo
    };
    return hoje.toLocaleDateString("pt-BR", opções);
}
// Declare SYSTEM_MESSAGE com 'let' para permitir reatribuição
let SYSTEM_MESSAGE = `Você é uma assistente telefônica da clínica Modelo. Nessa clínica atendem os profissionais listados no XML abaixo. hoje é dia ${obterDataFormatada()}, e você deve receber ligações de pessoas com intenção de marcar consulta com um dos profissionais, ou ambos... você pode fornecer duas datas disponíveis por vez e perguntar se alguma delas é de interesse do usuário, se não for, pode oferecer alguma outra data, como podem ter vários dias com vários horários cada, você pode começar perguntando se prefere pela manhã ou pela tarde, e baseado nisso, sugerir horários livres que estão na lista abaixo.

A clínica modelo fica situada na Avenida Dom Pedro II n 750, em São Lourenço, Minas Gerais.

Pergunte o nome completo do cliente caso ele queira marcar uma consulta;
Pergunte também se o numero de telefone para contato é o mesmo que ele usou para ligar.

Caso na mesma ligação o cliente queira marcar uma outra consulta para outra pessoa, lembre de perguntar o nome da outra pessoa também.

Confirme se a consulta será por algum plano de saúde, ou se será particular, ou se será retorno.

<Agenda>
    $resultadoDaApi
</Agenda>

<rules>
Ao sugerir datas, se a data for no mesmo mês atual, pode responder somente com o Dia sem mencionar o mês. fale dia e mês somente quando for para mês diferente do atual.

Faça somente uma pergunta por vez.

Após o usuário informar o nome completo, você pode chamá-lo posteriormente somente pelo primeiro nome.

Caso o numero de telefone não seja o mesmo que o cliente usou para ligar, pergunte se o numero de telefone.
</rules>
`;

// Função para obter os dados da API e atualizar a SYSTEM_MESSAGE
async function obterDados() {
    try {
        const url = "https://srv658237.hstgr.cloud/clinicas.php";

        // Criar um agente HTTPS que ignora certificados inválidos
        const httpsAgent = new https.Agent({
            rejectUnauthorized: false,
        });

        // Fazer a requisição usando o agente
        const resposta = await fetch(url, { agent: httpsAgent });

        if (!resposta.ok) {
            throw new Error(`Erro na requisição: ${resposta.statusText}`);
        }

        const conteudo = await resposta.text();

        // Substituir o placeholder $resultadoDaApi pelo conteúdo obtido
        SYSTEM_MESSAGE = SYSTEM_MESSAGE.replace("$resultadoDaApi", conteudo);

        // Exibir o resultado atualizado
        console.log(SYSTEM_MESSAGE);

        // Agora, você pode usar a SYSTEM_MESSAGE atualizada como desejar
    } catch (erro) {
        console.error("Erro ao fazer a requisição:", erro);
    }
}

// Chamar a função para executar o processo
obterDados().then(() => {
     setInterval(obterDados, 900000);
    // Coloque aqui qualquer código que dependa de SYSTEM_MESSAGE atualizado
    // Por exemplo, iniciar o servidor ou outras operações
    // Certifique-se de que todo o código que depende de SYSTEM_MESSAGE esteja dentro deste bloco

    const VOICE = "alloy";
    const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

    // List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
    const LOG_EVENT_TYPES = [
        "error",
        "response.content.done",
        "rate_limits.updated",
        "response.done",
        "input_audio_buffer.committed",
        "input_audio_buffer.speech_stopped",
        "input_audio_buffer.speech_started",
        "session.created",
    ];

    // Show AI response elapsed timing calculations
    const SHOW_TIMING_MATH = false;

    // Root Route
    fy.get("/", async (request, reply) => {
        reply.send({ message: "Twilio Media Stream Server is running!" });
    });

    // Route for Twilio to handle incoming calls
    // <Say> punctuation to improve text-to-speech translation
    // <Say language="pt-BR" voice="Polly.Camila">Oi, eu sou sua atendente da clínica Modelo, como posso te ajudar?</Say>
    fastify.all("/incoming-call", async (request, reply) => {
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Connect>
            <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
    </Response>
    `;

        reply.type("text/xml").send(twimlResponse);
    });

// WebSocket route for media-stream
    fastify.register(async (fastify) => {
        fastify.get("/media-stream", { websocket: true }, (connection, req) => {
            console.log("Client connected");

            // Connection-specific state
            let streamSid = null;
            let latestMediaTimestamp = 0;
            let lastAssistantItem = null;
            let markQueue = [];
            let responseStartTimestampTwilio = null;

            const openAiWs = new WebSocket(
                "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
                {
                    headers: {
                        Authorization: `Bearer ${OPENAI_API_KEY}`,
                        "OpenAI-Beta": "realtime=v1",
                    },
                },
            );
            console.log(SYSTEM_MESSAGE);
            // Controla a sessão inicial com a OpenAI
            const initializeSession = () => {
                const sessionUpdate = {
                    type: "session.update",
                    session: {
                        // Configuração para detecção de turno (turn detection)
                        turn_detection: {
                            type: "server_vad", // Tipo de detecção de turno
                            threshold: 0.5, // Limiar de ativação para VAD (0.0 a 1.0)
                            prefix_padding_ms: 300, // Áudio incluído antes da fala detectada (ms)
                            silence_duration_ms: 750, // Duração do silêncio para detectar o fim da fala (ms)
                        },
                        input_audio_format: "g711_ulaw", // Formato de áudio de entrada
                        output_audio_format: "g711_ulaw", // Formato de áudio de saída
                        voice: VOICE, // Voz configurada (definida anteriormente no seu código)
                        instructions: SYSTEM_MESSAGE, // Instruções do sistema (mensagem definida anteriormente)
                        modalities: ["text", "audio"], // Modalidades suportadas
                        temperature: 0.8, // Temperatura para geração de respostas
                        // Você pode adicionar mais configurações conforme necessário
                    },
                };

                console.log(
                    "Enviando atualização de sessão:",
                    JSON.stringify(sessionUpdate, null, 2), // Formata o JSON com indentação para melhor legibilidade
                );
                openAiWs.send(JSON.stringify(sessionUpdate));

                // Descomente a linha abaixo para que a AI inicie a conversa:
                sendInitialConversationItem();
            };

            // Send initial conversation item if AI talks first
            const sendInitialConversationItem = () => {
                const initialConversationItem = {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: 'Comprimente o usuario com boas vindas, diga: "Oi, sou um assistente da clinica modelo, como que eu posso te ajudar?"',
                            },
                        ],
                    },
                };

                if (SHOW_TIMING_MATH)
                    console.log(
                        "Sending initial conversation item:",
                        JSON.stringify(initialConversationItem),
                    );
                openAiWs.send(JSON.stringify(initialConversationItem));
                openAiWs.send(JSON.stringify({ type: "response.create" }));
            };

            // Handle interruption when the caller's speech starts
            const handleSpeechStartedEvent = () => {
                if (
                    markQueue.length > 0 &&
                    responseStartTimestampTwilio != null
                ) {
                    const elapsedTime =
                        latestMediaTimestamp - responseStartTimestampTwilio;
                    if (SHOW_TIMING_MATH)
                        console.log(
                            `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`,
                        );

                    if (lastAssistantItem) {
                        const truncateEvent = {
                            type: "conversation.item.truncate",
                            item_id: lastAssistantItem,
                            content_index: 0,
                            audio_end_ms: elapsedTime,
                        };
                        if (SHOW_TIMING_MATH)
                            console.log(
                                "Sending truncation event:",
                                JSON.stringify(truncateEvent),
                            );
                        openAiWs.send(JSON.stringify(truncateEvent));
                    }

                    connection.send(
                        JSON.stringify({
                            event: "clear",
                            streamSid: streamSid,
                        }),
                    );

                    // Reset
                    markQueue = [];
                    lastAssistantItem = null;
                    responseStartTimestampTwilio = null;
                }
            };

            // Send mark messages to Media Streams so we know if and when AI response playback is finished
            const sendMark = (connection, streamSid) => {
                if (streamSid) {
                    const markEvent = {
                        event: "mark",
                        streamSid: streamSid,
                        mark: { name: "responsePart" },
                    };
                    connection.send(JSON.stringify(markEvent));
                    markQueue.push("responsePart");
                }
            };

            // Open event for OpenAI WebSocket
            openAiWs.on("open", () => {
                console.log("Connected to the OpenAI Realtime API");
                setTimeout(initializeSession, 100);
            });

            // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
            openAiWs.on("message", (data) => {
                try {
                    const response = JSON.parse(data);

                    if (LOG_EVENT_TYPES.includes(response.type)) {
                        console.log(
                            `Received event: ${response.type}`,
                            response,
                        );
                    }

                    if (
                        response.type === "response.audio.delta" &&
                        response.delta
                    ) {
                        const audioDelta = {
                            event: "media",
                            streamSid: streamSid,
                            media: {
                                payload: Buffer.from(
                                    response.delta,
                                    "base64",
                                ).toString("base64"),
                            },
                        };
                        connection.send(JSON.stringify(audioDelta));

                        // First delta from a new response starts the elapsed time counter
                        if (!responseStartTimestampTwilio) {
                            responseStartTimestampTwilio = latestMediaTimestamp;
                            if (SHOW_TIMING_MATH)
                                console.log(
                                    `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`,
                                );
                        }

                        if (response.item_id) {
                            lastAssistantItem = response.item_id;
                        }

                        sendMark(connection, streamSid);
                    }

                    if (response.type === "input_audio_buffer.speech_started") {
                        handleSpeechStartedEvent();
                    }
                } catch (error) {
                    console.error(
                        "Error processing OpenAI message:",
                        error,
                        "Raw message:",
                        data,
                    );
                }
            });

            // Handle incoming messages from Twilio
            connection.on("message", (message) => {
                try {
                    const data = JSON.parse(message);

                    switch (data.event) {
                        case "media":
                            latestMediaTimestamp = data.media.timestamp;
                            if (SHOW_TIMING_MATH)
                                console.log(
                                    `Received media message with timestamp: ${latestMediaTimestamp}ms`,
                                );
                            if (openAiWs.readyState === WebSocket.OPEN) {
                                const audioAppend = {
                                    type: "input_audio_buffer.append",
                                    audio: data.media.payload,
                                };
                                openAiWs.send(JSON.stringify(audioAppend));
                            }
                            break;
                        case "start":
                            streamSid = data.start.streamSid;
                            console.log(
                                "Incoming stream has started",
                                streamSid,
                            );

                            // Reset start and media timestamp on a new stream
                            responseStartTimestampTwilio = null;
                            latestMediaTimestamp = 0;
                            break;
                        case "mark":
                            if (markQueue.length > 0) {
                                markQueue.shift();
                            }
                            break;
                        default:
                            console.log(
                                "Received non-media event:",
                                data.event,
                            );
                            break;
                    }
                } catch (error) {
                    console.error(
                        "Error parsing message:",
                        error,
                        "Message:",
                        message,
                    );
                }
            });

            // Handle connection close
            connection.on("close", () => {
                if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
                console.log("Client disconnected.");
            });

            // Handle WebSocket close and errors
            openAiWs.on("close", () => {
                console.log("Disconnected from the OpenAI Realtime API");
            });

            openAiWs.on("error", (error) => {
                console.error("Error in the OpenAI WebSocket:", error);
            });
        });
    });

    fastify.listen({ port: PORT }, (err) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`Server is listening on port ${PORT}`);
    });
});
