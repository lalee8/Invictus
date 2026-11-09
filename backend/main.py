import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from database import engine, Base
import models

from routers.accounts import router as accounts_router


app = FastAPI(
    title="ResiliNode AI API",
    description="Backend for ResiliNode AI ATM Kiosk",
    version="1.0.0"
)

Base.metadata.create_all(bind=engine)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(accounts_router)


@app.get("/api")
def home():
    return {
        "message": "ResiliNode AI Backend is running",
        "status": "online"
    }


@app.get("/health")
def health_check():
    return {
        "status": "healthy"
    }


# ===== Serve the website (frontend folder) =====
# Must be added LAST, after all API routes.
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")

if os.path.isdir(FRONTEND_DIR):
       app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")