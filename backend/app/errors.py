from typing import Any


class APIError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ):
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}
        self.headers = headers or {}


def invalid(message: str, **details):
    return APIError(400, "invalid_input", message, details)


def not_found():
    return APIError(404, "not_found", "Resource not found")
