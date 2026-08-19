import axios from "axios";

export function okResult(result) {
  return {
    structuredContent: result,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export function errorResult(context, error) {
  let message = error instanceof Error ? error.message : String(error);

  if (axios.isAxiosError(error)) {
    message = error.response
      ? `HTTP ${error.response.status} ao acessar a URL`
      : error.code === "ECONNABORTED"
        ? "Tempo limite de 15 segundos excedido"
        : `Falha HTTP: ${error.message}`;
  }

  return {
    isError: true,
    content: [{ type: "text", text: `${context}: ${message}` }],
  };
}
