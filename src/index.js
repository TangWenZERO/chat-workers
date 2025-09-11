import { createSchema, createYoga } from 'graphql-yoga';
/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// GraphQL Schema
const typeDefs = /* GraphQL */ `
	type Query {
		message: String!
		model: String!
		token: String!
	}

	type Subscription {
		chatStream(prompt: [MessageInput!]!, token: String!): ChatDelta!
	}

	input MessageInput {
		role: String!
		content: String!
	}

	type ChatDelta {
		content: String
		id: String!
		model: String
		created: Int
		finish_reason: String
	}
`;

// deepseek 的请求
async function requestDeepSeek(messages, model, token) {
	const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
	if (!token) throw new Error('API key not provided');
	const response = await fetch(DEEPSEEK_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			model: model || 'deepseek-chat',
			messages,
			stream: true,
		}),
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
	}
	return response;
}

// GraphQL 参数配置
const graphqlConfig = {
	Query: {
		message: () => 'Hello World!',
		model: () => 'deepseek',
		token: () => '',
	},
	Subscription: {
		chatStream: {
			subscribe: async function* (_parent, args) {
				const { prompt, token } = args;
				const response = await requestDeepSeek(prompt, 'deepseek-chat', token);

				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (!line.trim().startsWith('data: ')) continue;
						const data = line.trim().slice(6);
						if (data === '[DONE]') return;

						try {
							const parsed = JSON.parse(data);
							const delta = parsed.choices?.[0]?.delta;

							if (delta?.content) {
								yield {
									chatStream: {
										content: delta.content,
										id: parsed.id,
										model: parsed.model,
										created: parsed.created,
										finish_reason: null,
									},
								};
							}

							if (parsed.choices?.[0]?.finish_reason) {
								yield {
									chatStream: {
										content: null,
										id: parsed.id,
										model: parsed.model,
										created: parsed.created,
										finish_reason: parsed.choices[0].finish_reason,
									},
								};
							}
						} catch (err) {
							console.error('Parse error:', err, data);
						}
					}
				}
			},
		},
	},
};

// 处理 DeepSeek 流数据解构
async function processDeepSeekStream(reader, decoder, writer) {
	try {
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Send final event
				await writer.write(new TextEncoder().encode('event: done\ndata: [DONE]\n\n'));
				await writer.close();
				break;
			}

			buffer += decoder.decode(value, { stream: true });

			// Process complete lines
			const lines = buffer.split('\n');
			buffer = lines.pop() || ''; // Keep incomplete line in buffer

			for (const line of lines) {
				const trimmedLine = line.trim();

				if (trimmedLine === '') continue;

				if (trimmedLine.startsWith('data: ')) {
					const data = trimmedLine.slice(6);

					if (data === '[DONE]') {
						await writer.write(new TextEncoder().encode('event: done\ndata: [DONE]\n\n'));
						continue;
					}

					try {
						const parsed = JSON.parse(data);

						// Extract the content from the response
						if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
							const delta = parsed.choices[0].delta;

							if (delta.content) {
								// Send the content as SSE
								const sseData = JSON.stringify({
									content: delta.content,
									id: parsed.id,
									model: parsed.model,
									created: parsed.created,
								});

								await writer.write(new TextEncoder().encode(`data: ${sseData}\n\n`));
							}

							// Handle finish reason
							if (parsed.choices[0].finish_reason) {
								const finishData = JSON.stringify({
									finish_reason: parsed.choices[0].finish_reason,
									id: parsed.id,
								});

								await writer.write(new TextEncoder().encode(`event: finish\ndata: ${finishData}\n\n`));
							}
						}
					} catch (parseError) {
						console.error('JSON parse error:', parseError, 'Data:', data);
					}
				}
			}
		}
	} catch (error) {
		console.error('Stream processing error:', error);

		// Send error event
		const errorData = JSON.stringify({ error: error.message });
		await writer.write(new TextEncoder().encode(`event: error\ndata: ${errorData}\n\n`));
		await writer.close();
	}
}
// 创建graphql实例
const yoga = createYoga({
	schema: createSchema({ typeDefs, resolvers: graphqlConfig }),
	graphqlEndpoint: '/graphql/sse',
	graphiql: { subscriptionsProtocol: 'SSE' },
	cors: {
		origin: '*',
		credentials: false,
		allowedHeaders: ['Content-Type', 'Authorization'],
		methods: ['GET', 'POST', 'OPTIONS'],
	},
});

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// 浏览器做预检
		/**
		 * 1. Content-Type 不是简单类型：
		 * 		application/json 不是简单的 Content-Type
		 * 		简单类型只包括：text/plain、application/x-www-form-urlencoded、multipart/form-data
		 * 2. 包含自定义请求头：
		 * 		如 Authorization、X-Custom-Header 等
		 * 3. HTTP 方法不是简单方法：
		 * 		虽然 POST 是简单方法，但结合上述条件就会触发预检
		 */
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				},
			});
		}

		if (url.pathname === '/deepseek/api') {
			if (request.method !== 'POST') {
				return new Response('Method not allowed', { status: 405 });
			}

			try {
				const { messages, model, token = '' } = await request.json();

				// 调用 DeepSeek API
				const response = await requestDeepSeek(messages, model, token);

				// 创建SSE输出数据
				const { readable, writable } = new TransformStream();
				const writer = writable.getWriter();
				const reader = response.body.getReader();
				const decoder = new TextDecoder();

				// 处理 DeepSeek 流数据
				processDeepSeekStream(reader, decoder, writer);

				return new Response(readable, {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Credentials': 'true',
					},
				});
			} catch (error) {
				return new Response(`Internal server error: ${error.message}`, { status: 500 });
			}
		}
		/**
		 * graphql 返回sse 数据
		 */
		if (url.pathname === '/graphql/sse') {
			return yoga.fetch(request);
		}

		return new Response('Hello World!');
	},
};
