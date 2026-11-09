"""Build role-aware decorators for protected Flask endpoints."""

from functools import wraps
import jwt
from flask import g, jsonify, request


def create_authenticator(query, secret_key):
    # Share one authentication rule across every protected API endpoint.
    def auth(required=True, roles=None):
        def decorator(route_handler):
            @wraps(route_handler)
            def wrapped(*args, **kwargs):
                authorization = request.headers.get("Authorization", "")
                token = authorization.removeprefix("Bearer ").strip()
                if not token:
                    if required:
                        return jsonify(error="Authentication required"), 401
                    g.user = None
                    return route_handler(*args, **kwargs)
                try:
                    payload = jwt.decode(token, secret_key, algorithms=["HS256"])
                    user = query(
                        "SELECT id,name,email,role,blocked FROM users WHERE id=%s",
                        (int(payload["sub"]),),
                        one=True,
                    )
                    if not user:
                        return jsonify(error="Account no longer exists"), 401
                    if user.get("blocked"):
                        return jsonify(error="This account is blocked. Contact an administrator."), 403
                    if roles and user["role"] not in roles:
                        return jsonify(error="Insufficient permissions"), 403
                    g.user = user
                except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
                    return jsonify(error="Invalid or expired token"), 401
                return route_handler(*args, **kwargs)
            return wrapped
        return decorator
    return auth
