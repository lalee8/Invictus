import secrets
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pwdlib import PasswordHash

from database import get_db
from models import Account, Transaction
from schemas import (
    AccountCreate,
    AccountResponse,
    TransactionRequest,
    BalanceResponse,
    TransactionResponse,
    LoginRequest,
    LoginResponse
)

router = APIRouter(prefix="/accounts", tags=["Accounts"])

password_hash = PasswordHash.recommended()


def verify_account(account, pin):
    if not password_hash.verify(pin, account.pin_hash):
        raise HTTPException(status_code=401, detail="Invalid PIN")

    if not account.is_active:
        raise HTTPException(status_code=403, detail="Account is inactive")


@router.post("/", response_model=AccountResponse)
def create_account(data: AccountCreate, db: Session = Depends(get_db)):

    if data.currency not in ["AZN", "USD", "EUR"]:
        raise HTTPException(status_code=400, detail="Unsupported currency")

    account_number = None

    for _ in range(10):
        candidate = str(secrets.randbelow(10**10)).zfill(10)

        if not db.query(Account).filter(
            Account.account_number == candidate
        ).first():
            account_number = candidate
            break

    if account_number is None:
        raise HTTPException(
            status_code=500,
            detail="Could not generate account number"
        )

    account = Account(
        account_number=account_number,
        owner_name=data.owner_name,
        pin_hash=password_hash.hash(data.pin),
        balance=Decimal("0.00"),
        currency=data.currency
    )

    db.add(account)
    db.commit()
    db.refresh(account)

    return account


@router.post("/login", response_model=LoginResponse)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    """Log in with card (account) number and PIN"""

    account = db.query(Account).filter(
        Account.account_number == data.account_number
    ).first()

    # Same message for wrong card and wrong PIN (safer)
    if not account or not password_hash.verify(data.pin, account.pin_hash):
        raise HTTPException(status_code=401, detail="Invalid card number or PIN")

    if not account.is_active:
        raise HTTPException(status_code=403, detail="Account is inactive")

    return account


@router.get("/{account_id}/balance", response_model=BalanceResponse)
def check_balance(account_id: int, pin: str, db: Session = Depends(get_db)):

    account = db.query(Account).filter(
        Account.id == account_id
    ).first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    verify_account(account, pin)

    return {
        "account_number": account.account_number,
        "balance": account.balance,
        "currency": account.currency
    }


@router.post("/{account_id}/deposit", response_model=TransactionResponse)
def deposit(
    account_id: int,
    data: TransactionRequest,
    db: Session = Depends(get_db)
):

    account = db.query(Account).filter(
        Account.id == account_id
    ).with_for_update().first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    verify_account(account, data.pin)

    account.balance += data.amount

    transaction = Transaction(
        account_id=account.id,
        transaction_type="DEPOSIT",
        amount=data.amount,
        currency=account.currency,
        balance_after=account.balance
    )

    db.add(transaction)
    db.commit()
    db.refresh(transaction)

    return transaction


@router.post("/{account_id}/withdraw", response_model=TransactionResponse)
def withdraw(
    account_id: int,
    data: TransactionRequest,
    db: Session = Depends(get_db)
):

    account = db.query(Account).filter(
        Account.id == account_id
    ).with_for_update().first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    verify_account(account, data.pin)

    if account.balance < data.amount:
        raise HTTPException(
            status_code=400,
            detail="Insufficient funds"
        )

    account.balance -= data.amount

    transaction = Transaction(
        account_id=account.id,
        transaction_type="WITHDRAW",
        amount=data.amount,
        currency=account.currency,
        balance_after=account.balance
    )

    db.add(transaction)
    db.commit()
    db.refresh(transaction)

    return transaction


@router.get(
    "/{account_id}/transactions",
    response_model=list[TransactionResponse]
)
def get_transactions(
    account_id: int,
    pin: str,
    db: Session = Depends(get_db)
):

    account = db.query(Account).filter(
        Account.id == account_id
    ).first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    verify_account(account, pin)

    return db.query(Transaction).filter(
        Transaction.account_id == account_id
    ).order_by(Transaction.created_at.desc()).all()