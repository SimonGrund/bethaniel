#!/bin/bash

# Create the main required directories
mkdir -p Code Data Results tmp Backup Notes

# Create the nested structure inside Backup
mkdir -p Backup/Code
mkdir -p Backup/Data
mkdir -p Backup/Results

# Create symbolic links in the root directory
ln -s Backup/Code Code
ln -s Backup/Data Data
ln -s Backup/Results Results

echo "Directory structure set up successfully."
