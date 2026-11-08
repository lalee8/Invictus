
from sqlalchemy import (
    Column, Integer, String, Boolean,
    Numeric, DateTime, ForeignKey
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from database import Base


class Account(Base):
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, index=True)
    account_number = Column(String(10), unique=True, index=True, nullable=False)
    owner_name = Column(String(100), nullable=False)
    pin_hash = Column(String(255), nullable=False)
    balance = Column(Numeric(12, 2), default=0, nullable=False)
    currency = Column(String(3), default="AZN", nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)

    transactions = relationship(
        "Transaction",
        back_populates="account",
        cascade="all, delete-orphan"
    )


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    account_id = Column(
        Integer,
        ForeignKey("accounts.id"),
        nullable=False
    )
    transaction_type = Column(String(20), nullable=False)
    amount = Column(Numeric(12, 2), nullable=False)
    currency = Column(String(3), nullable=False)
    balance_after = Column(Numeric(12, 2), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    account = relationship("Account", back_populates="transactions")
