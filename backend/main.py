
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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


@app.get("/")
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
