# Purpose: Expose the Flask and Socket.IO application to the Gunicorn server.
# Role: Start the single-process SLA worker used by the AWS EC2 service.
"""Production Gunicorn entry point for Flask and the shared Socket.IO service."""

from app import app, socketio, sla_escalation_worker

# Start the SLA loop once in the single Gunicorn worker that owns Socket.IO presence.
socketio.start_background_task(sla_escalation_worker)
