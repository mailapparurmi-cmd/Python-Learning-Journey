# Program to check ATM withdrawal

amount = int(input("Enter withdrawal amount: "))

if amount <= 100000:
    print("Collect your amount")
else:
    print("Insufficient Balance")