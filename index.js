import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";
import https from "https";

dotenv.config();
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error("Missing OpenAI API key. Please set it in the .env file.");
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

function obterDataFormatada() {
    const hoje = new Date();
    const opções = {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
    };
    return hoje.toLocaleDateString("pt-BR", opções);
}

const SYSTEM_MESSAGE_BASE = `Você é uma assistente telefônica da clínica Modelo. Nessa clínica atendem os profissionais listados no XML abaixo. hoje é dia ${obterDataFormatada()}, e você deve receber ligações de pessoas com intenção de marcar consulta com um dos profissionais, ou ambos... você pode fornecer duas datas disponíveis por vez e perguntar se alguma delas é de interesse do usuário, se não for, pode oferecer alguma outra data, como podem ter vários dias com vários horários cada, você pode começar perguntando se prefere pela manhã ou pela tarde, e baseado nisso, sugerir horários livres que estão na lista abaixo.

A clínica modelo fica situada na Avenida Dom Pedro II n 750, em São Lourenço, Minas Gerais.

Pergunte o nome completo do cliente caso ele queira marcar uma consulta;
Pergunte também se o numero de telefone para contato é o mesmo que ele usou para ligar.

Caso na mesma ligação o cliente queira marcar uma outra consulta para outra pessoa, lembre de perguntar o nome da outra pessoa também.

Confirme se a consulta será por algum plano de saúde, ou se será particular, ou se será retorno.

<rules>
Ao sugerir datas, se a data for no mesmo mês atual, pode responder somente com o Dia sem mencionar o mês. fale dia e mês somente quando for para mês diferente do atual.

Faça somente uma pergunta por vez.

Após o usuário informar o nome completo, você pode chamá-lo posteriormente somente pelo primeiro nome.

Caso o numero de telefone não seja o mesmo que o cliente usou para ligar, pergunte se o numero de telefone.
</rules>`;

async function fetchAgendaData() {
    const url = "https://srv658237.hstgr.cloud/clinica.php";
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    try {
        const response = await fetch(url, { agent: httpsAgent });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const data = await response.text();
        return data;
    } catch (error) {
        console.error("Error fetching agenda data:", error);
        return "";
    }
}

const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

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

const SHOW_TIMING_MATH = false;

fastify.get("/", async (request, reply) => {
    reply.send({ message: "Twilio Media Stream Server is running!" });
});

fastify.all("/incoming-call", async (request, reply) => {
    const agendaData = await fetchAgendaData();
    global.SYSTEM_MESSAGE =
        SYSTEM_MESSAGE_BASE + "\n<Agenda>\n" + agendaData + "\n</Agenda>";
    console.log(SYSTEM_MESSAGE);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Connect>
            <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
    </Response>`;

    reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection, req) => {
        console.log("Client connected");

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

        const initializeSession = () => {
            const sessionUpdate = {
                type: "session.update",
                session: {
                    turn_detection: {
                        type: "server_vad",
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 750,
                    },
                    input_audio_format: "g711_ulaw",
                    output_audio_format: "g711_ulaw",
                    voice: VOICE,
                    instructions: global.SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                },
            };

            console.log(
                "Session Update:",
                JSON.stringify(sessionUpdate, null, 2),
            );
            openAiWs.send(JSON.stringify(sessionUpdate));
            sendInitialConversationItem();
        };

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

            if (SHOW_TIMING_MATH) {
                console.log(
                    "Initial conversation item:",
                    JSON.stringify(initialConversationItem),
                );
            }
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: "response.create" }));
        };

        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime =
                    latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) {
                    console.log(`Elapsed time: ${elapsedTime}ms`);
                }

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: "conversation.item.truncate",
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime,
                    };
                    if (SHOW_TIMING_MATH) {
                        console.log(
                            "Truncation event:",
                            JSON.stringify(truncateEvent),
                        );
                    }
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(
                    JSON.stringify({
                        event: "clear",
                        streamSid: streamSid,
                    }),
                );

                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

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

        openAiWs.on("open", () => {
            console.log("Connected to OpenAI Realtime API");
            setTimeout(initializeSession, 100);
        });

        openAiWs.on("message", (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Event: ${response.type}`, response);
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

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) {
                            console.log(
                                `Start timestamp: ${responseStartTimestampTwilio}ms`,
                            );
                        }
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
                console.error("Error processing message:", error, "Raw:", data);
            }
        });

        connection.on("message", (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case "media":
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) {
                            console.log(
                                `Media timestamp: ${latestMediaTimestamp}ms`,
                            );
                        }
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
                        console.log("Stream started:", streamSid);
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        break;
                    case "mark":
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log("Non-media event:", data.event);
                        break;
                }
            } catch (error) {
                console.error("Parse error:", error, "Message:", message);
            }
        });

        connection.on("close", () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log("Client disconnected");
        });

        openAiWs.on("close", () => {
            console.log("Disconnected from OpenAI API");
        });

        openAiWs.on("error", (error) => {
            console.error("OpenAI WebSocket error:", error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
});
