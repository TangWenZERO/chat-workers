/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
// 处理 DeepSeek 流数据
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

// 处理 ChatGPT 流数据
async function processChatGPTStream(reader, decoder, writer) {
	try {
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Send final event
				await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
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
						await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
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
		await writer.write(new TextEncoder().encode(`data: ${errorData}\n\n`));
		await writer.close();
	}
}
export default {
	async fetch(request, env, ctx) {
		// 调用 DeepSeek API
		async function callDeepSeekAPI(messages, model, token) {
			const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
			const API_KEY = token;

			if (!API_KEY) {
				throw new Error('API key not configured');
			}

			const response = await fetch(DEEPSEEK_API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${API_KEY}`,
				},
				body: JSON.stringify({
					model: model || 'deepseek-chat',
					messages,
					stream: true,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('DeepSeek API error:', errorText);
				throw new Error(`DeepSeek API error: ${response.status}`);
			}

			return response;
		}

		// 调用 ChatGPT API
		async function callChatGPTAPI(messages, model, token) {
			const CHATGPT_API_URL = 'https://api.openai.com/v1/chat/completions';
			const API_KEY = token;

			if (!API_KEY) {
				throw new Error('API key not configured');
			}

			const response = await fetch(CHATGPT_API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${API_KEY}`,
				},
				body: JSON.stringify({
					model: model || 'gpt-3.5-turbo',
					messages,
					stream: true,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('ChatGPT API error:', errorText);
				throw new Error(`ChatGPT API error: ${response.status}`);
			}

			return response;
		}
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
		const url = new URL(request.url);
		console.log(url.pathname, request.method);

		if (url.pathname === '/chat/api') {
			if (request.method !== 'POST') {
				return new Response('Method not allowed', { status: 405 });
			}

			try {
				const { messages, token = '', type = 'deepseek' } = await request.json();
				const model = type === 'chatgpt' ? 'gpt-5' : 'deepseek-chat';
				// 根据 type 参数选择不同的 API
				let response;
				if (type === 'chatgpt') {
					response = await callChatGPTAPI(messages, model, token);
				} else {
					// 默认使用 deepseek
					response = await callDeepSeekAPI(messages, model, token);
				}

				// 创建SSE输出数据
				const { readable, writable } = new TransformStream();
				const writer = writable.getWriter();
				const reader = response.body.getReader();
				const decoder = new TextDecoder();

				// 根据 type 参数选择不同的流处理函数
				if (type === 'chatgpt') {
					processChatGPTStream(reader, decoder, writer);
				} else {
					// 默认使用 deepseek 流处理
					processDeepSeekStream(reader, decoder, writer);
				}

				return new Response(readable, {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
						'Access-Control-Allow-Origin': '*',
					},
				});
			} catch (error) {
				console.error('Error:', error);
				return new Response(`Internal server error: ${error.message}`, { status: 500 });
			}
		}

		return new Response('Hello World!');
	},
};
